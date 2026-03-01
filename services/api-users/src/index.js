require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const Redis = require("ioredis");

const app = express();
app.use(express.json());

// ─── DB Connection ────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ─── Redis Connection ─────────────────────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL);

// ─── Init DB Schema ───────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id        SERIAL PRIMARY KEY,
      name      VARCHAR(100) NOT NULL,
      email     VARCHAR(150) UNIQUE NOT NULL,
      password  VARCHAR(255) NOT NULL,
      role      VARCHAR(20) DEFAULT 'user',
      active    BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  `);
  console.log("✅ DB schema initialized");
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check (usado por Kong y Docker)
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    await redis.ping();
    res.json({ status: "ok", service: "api-users", timestamp: new Date() });
  } catch (err) {
    res.status(503).json({ status: "error", message: err.message });
  }
});

// Listar usuarios (con caché Redis)
app.get("/api/users", async (req, res) => {
  try {
    const cacheKey = "users:all";
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json({ source: "cache", data: JSON.parse(cached) });
    }

    const { rows } = await pool.query(
      "SELECT id, name, email, role, active, created_at FROM users ORDER BY id DESC LIMIT 100"
    );

    await redis.setex(cacheKey, 30, JSON.stringify(rows)); // TTL 30s
    res.json({ source: "db", data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obtener usuario por ID
app.get("/api/users/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, email, role, active, created_at FROM users WHERE id = $1",
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Crear usuario
app.post("/api/users", async (req, res) => {
  const { name, email, password, role = "user" } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: "name, email and password are required" });
  }
  try {
    const bcrypt = require("bcryptjs");
    const hashed = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      "INSERT INTO users(name,email,password,role) VALUES($1,$2,$3,$4) RETURNING id,name,email,role,created_at",
      [name, email, hashed, role]
    );
    await redis.del("users:all"); // Invalidar caché
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Email already exists" });
    res.status(500).json({ error: err.message });
  }
});

// Actualizar usuario
app.put("/api/users/:id", async (req, res) => {
  const { name, active } = req.body;
  try {
    const { rows } = await pool.query(
      "UPDATE users SET name=COALESCE($1,name), active=COALESCE($2,active), updated_at=NOW() WHERE id=$3 RETURNING id,name,email,active",
      [name, active, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    await redis.del("users:all");
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar usuario
app.delete("/api/users/:id", async (req, res) => {
  try {
    const { rowCount } = await pool.query("DELETE FROM users WHERE id=$1", [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: "User not found" });
    await redis.del("users:all");
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`🚀 api-users running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to init DB:", err);
    process.exit(1);
  });
