require("dotenv").config();
const express = require("express");
const multer = require("multer");
const multerS3 = require("multer-s3");
const { v4: uuidv4 } = require("uuid");
const mime = require("mime-types");
const { Pool } = require("pg");
const Redis = require("ioredis");

const {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");

const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
app.use(express.json());

// ─── Clientes ─────────────────────────────────────────────────────────────────
const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);

const BUCKET = process.env.S3_BUCKET_NAME;
const SIGNED_URL_EXPIRES = parseInt(process.env.SIGNED_URL_EXPIRES_SECONDS || "3600");

// ─── Validaciones ──────────────────────────────────────────────────────────────
const ALLOWED_MIME_TYPES = [
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "application/pdf",
  "text/plain", "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip",
];

const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || "50");

// ─── Multer + S3 ──────────────────────────────────────────────────────────────
const upload = multer({
  storage: multerS3({
    s3,
    bucket: BUCKET,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    metadata: (req, file, cb) => {
      cb(null, {
        uploadedBy: req.headers["x-consumer-username"] || "anonymous",
        originalName: Buffer.from(file.originalname).toString("base64"),
        service: "api-files",
      });
    },
    key: (req, file, cb) => {
      // Estructura: {folder}/{año}/{mes}/{uuid}.{ext}
      const folder = req.params.folder || "general";
      const ext = mime.extension(file.mimetype) || "bin";
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const key = `${folder}/${year}/${month}/${uuidv4()}.${ext}`;
      cb(null, key);
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
    }
  },
});

// ─── Init DB ──────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS files (
      id           SERIAL PRIMARY KEY,
      uuid         UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
      original_name VARCHAR(255) NOT NULL,
      s3_key       VARCHAR(500) NOT NULL UNIQUE,
      bucket       VARCHAR(100) NOT NULL,
      mime_type    VARCHAR(100),
      size_bytes   BIGINT,
      folder       VARCHAR(100) DEFAULT 'general',
      uploaded_by  VARCHAR(100),
      is_public    BOOLEAN DEFAULT false,
      deleted_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_files_uuid    ON files(uuid);
    CREATE INDEX IF NOT EXISTS idx_files_folder  ON files(folder);
    CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(deleted_at);
  `);
  console.log("✅ DB schema (files) initialized");
}

// ─── Helper: guardar registro en BD ──────────────────────────────────────────
async function saveFileToDB(file, folder, uploadedBy) {
  const originalName = file.originalname;
  const { rows } = await pool.query(
    `INSERT INTO files(original_name, s3_key, bucket, mime_type, size_bytes, folder, uploaded_by)
     VALUES($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, uuid, original_name, s3_key, mime_type, size_bytes, folder, created_at`,
    [originalName, file.key, BUCKET, file.mimetype, file.size, folder, uploadedBy]
  );
  return rows[0];
}

// ─── RUTAS ────────────────────────────────────────────────────────────────────

// Health check
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    await redis.ping();
    // Verificar conexión a S3
    await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 1 }));
    res.json({ status: "ok", service: "api-files", bucket: BUCKET });
  } catch (err) {
    res.status(503).json({ status: "error", message: err.message });
  }
});

// ── POST /api/files/:folder — Subir un archivo
app.post("/api/files/:folder", (req, res) => {
  const uploadSingle = upload.single("file");

  uploadSingle(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No se envió ningún archivo (campo: file)" });
    }

    try {
      const uploadedBy = req.headers["x-consumer-username"] || "anonymous";
      const record = await saveFileToDB(req.file, req.params.folder, uploadedBy);

      // URL firmada temporal para acceso inmediato
      const signedUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET, Key: req.file.key }),
        { expiresIn: SIGNED_URL_EXPIRES }
      );

      res.status(201).json({
        message: "Archivo subido exitosamente",
        file: {
          ...record,
          signed_url: signedUrl,
          signed_url_expires_in: `${SIGNED_URL_EXPIRES}s`,
        },
      });
    } catch (dbErr) {
      // Intentar borrar de S3 si falla la BD
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: req.file.key })).catch(() => {});
      res.status(500).json({ error: dbErr.message });
    }
  });
});

// ── POST /api/files/:folder/multiple — Subir múltiples archivos (máx 10)
app.post("/api/files/:folder/multiple", (req, res) => {
  const uploadMultiple = upload.array("files", 10);

  uploadMultiple(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.files?.length) return res.status(400).json({ error: "No se enviaron archivos" });

    const uploadedBy = req.headers["x-consumer-username"] || "anonymous";
    const results = [];

    for (const file of req.files) {
      try {
        const record = await saveFileToDB(file, req.params.folder, uploadedBy);
        results.push({ success: true, file: record });
      } catch (dbErr) {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: file.key })).catch(() => {});
        results.push({ success: false, original_name: file.originalname, error: dbErr.message });
      }
    }

    res.status(207).json({ results });
  });
});

// ── GET /api/files — Listar archivos (con filtros y paginación)
app.get("/api/files", async (req, res) => {
  const { folder, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const cacheKey = `files:list:${folder || "all"}:${page}:${limit}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return res.json({ source: "cache", ...JSON.parse(cached) });

    let query = `SELECT id, uuid, original_name, s3_key, mime_type, size_bytes, folder, uploaded_by, created_at
                 FROM files WHERE deleted_at IS NULL`;
    const params = [];

    if (folder) {
      params.push(folder);
      query += ` AND folder = $${params.length}`;
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), offset);

    const { rows } = await pool.query(query, params);

    // Contar total
    const countQuery = folder
      ? "SELECT COUNT(*) FROM files WHERE deleted_at IS NULL AND folder = $1"
      : "SELECT COUNT(*) FROM files WHERE deleted_at IS NULL";
    const { rows: countRows } = await pool.query(countQuery, folder ? [folder] : []);
    const total = parseInt(countRows[0].count);

    const payload = { data: rows, total, page: parseInt(page), limit: parseInt(limit) };
    await redis.setex(cacheKey, 15, JSON.stringify(payload));
    res.json({ source: "db", ...payload });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/files/:uuid — Obtener URL firmada de un archivo
app.get("/api/files/:uuid", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM files WHERE uuid = $1 AND deleted_at IS NULL",
      [req.params.uuid]
    );
    if (!rows.length) return res.status(404).json({ error: "Archivo no encontrado" });

    const file = rows[0];

    // Verificar que existe en S3
    await s3.send(new HeadObjectCommand({ Bucket: file.bucket, Key: file.s3_key }));

    const signedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: file.bucket, Key: file.s3_key }),
      { expiresIn: SIGNED_URL_EXPIRES }
    );

    res.json({
      ...file,
      signed_url: signedUrl,
      signed_url_expires_in: `${SIGNED_URL_EXPIRES}s`,
    });
  } catch (err) {
    if (err.name === "NotFound") return res.status(404).json({ error: "Archivo no existe en S3" });
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/files/:uuid — Soft delete en BD + borrar de S3
app.delete("/api/files/:uuid", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "UPDATE files SET deleted_at = NOW() WHERE uuid = $1 AND deleted_at IS NULL RETURNING *",
      [req.params.uuid]
    );
    if (!rows.length) return res.status(404).json({ error: "Archivo no encontrado" });

    // Borrar de S3
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: rows[0].s3_key }));

    // Limpiar caché
    const keys = await redis.keys("files:list:*");
    if (keys.length) await redis.del(...keys);

    res.json({ message: "Archivo eliminado", uuid: req.params.uuid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Manejo de errores global ─────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3004;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 api-files running on port ${PORT}`));
}).catch((err) => {
  console.error("Failed to init:", err);
  process.exit(1);
});
