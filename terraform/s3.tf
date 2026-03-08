terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region"    { default = "us-east-1" }
variable "bucket_name"   { description = "Nombre único del bucket S3" }
variable "environment"   { default = "production" }
variable "app_user_name" { default = "devops-project-s3-user" }

# ─── Bucket S3 ───────────────────────────────────────────────────────────────
resource "aws_s3_bucket" "files" {
  bucket = var.bucket_name

  tags = {
    Name        = var.bucket_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# Bloquear acceso público (los archivos se acceden via Signed URLs)
resource "aws_s3_bucket_public_access_block" "files" {
  bucket                  = aws_s3_bucket.files.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Versionado (permite recuperar archivos borrados)
resource "aws_s3_bucket_versioning" "files" {
  bucket = aws_s3_bucket.files.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Cifrado en reposo (AES-256)
resource "aws_s3_bucket_server_side_encryption_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# CORS — permite subida directa desde browser si se requiere
resource "aws_s3_bucket_cors_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST", "DELETE", "HEAD"]
    allowed_origins = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

# Lifecycle: mover a Glacier archivos de más de 90 días
resource "aws_s3_bucket_lifecycle_configuration" "files" {
  bucket = aws_s3_bucket.files.id

  rule {
    id     = "archive-old-files"
    status = "Enabled"

    # Filtro requerido — aplica a todos los objetos
    filter {
      prefix = ""
    }

    transition {
      days          = 90
      storage_class = "GLACIER"
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# ─── IAM: Usuario con acceso mínimo solo a este bucket ───────────────────────
resource "aws_iam_user" "app_user" {
  name = var.app_user_name
  tags = { Environment = var.environment }
}

resource "aws_iam_access_key" "app_user" {
  user = aws_iam_user.app_user.name
}

resource "aws_iam_user_policy" "app_s3_policy" {
  name = "devops-project-s3-policy"
  user = aws_iam_user.app_user.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ListBucket"
        Effect = "Allow"
        Action = ["s3:ListBucket", "s3:GetBucketLocation"]
        Resource = aws_s3_bucket.files.arn
      },
      {
        Sid    = "ReadWriteObjects"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:GetObjectAttributes",
          "s3:HeadObject",
        ]
        Resource = "${aws_s3_bucket.files.arn}/*"
      }
    ]
  })
}

# ─── Outputs ──────────────────────────────────────────────────────────────────
output "bucket_name" {
  value = aws_s3_bucket.files.id
}

output "bucket_arn" {
  value = aws_s3_bucket.files.arn
}

output "bucket_region" {
  value = var.aws_region
}

output "iam_user_access_key_id" {
  value     = aws_iam_access_key.app_user.id
  sensitive = true
}

output "iam_user_secret_access_key" {
  value     = aws_iam_access_key.app_user.secret
  sensitive = true
}
