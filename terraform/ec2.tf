# ─── Variables EC2 ───────────────────────────────────────────────────────────
variable "key_pair_name" {
  description = "Nombre del Key Pair en AWS (créalo en EC2 → Key Pairs y pon el nombre aquí)"
}

variable "instance_type" {
  default     = "t3.medium"
  description = "Tipo de instancia EC2 (t3.medium = 4 GB RAM, 2 vCPU — mínimo recomendado para este stack)"
}

variable "root_volume_size_gb" {
  default     = 30
  description = "Tamaño del disco raíz en GB (30 GB mínimo para Docker images)"
}

# ─── Data: Ubuntu 22.04 LTS AMI (última versión oficial de Canonical) ────────
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical (oficial)

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ─── Security Group ───────────────────────────────────────────────────────────
resource "aws_security_group" "devops" {
  name        = "devops-project-sg"
  description = "Security group para el DevOps stack"

  # SSH — solo para administración
  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"] # Cambiar a tu IP: ["TU_IP/32"]
  }

  # HTTP — entrada principal (WAF + NGINX)
  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTPS — para cuando configures SSL con Certbot
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Konga UI
  ingress {
    description = "Konga UI"
    from_port   = 1337
    to_port     = 1337
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Grafana
  ingress {
    description = "Grafana"
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Kong Admin API — SOLO para desarrollo, cerrar en producción
  ingress {
    description = "Kong Admin API (cerrar en producción)"
    from_port   = 8001
    to_port     = 8001
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"] # Cambiar a tu IP: ["TU_IP/32"]
  }

  # Prometheus
  ingress {
    description = "Prometheus"
    from_port   = 9090
    to_port     = 9090
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Todo el tráfico saliente permitido
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "devops-project-sg"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ─── Script de arranque (user_data) ──────────────────────────────────────────
# Se ejecuta automáticamente una sola vez al crear la instancia.
# Instala Docker, Docker Compose y clona el proyecto listo para usar.
locals {
  user_data = <<-EOF
    #!/bin/bash
    set -e
    exec > /var/log/user-data.log 2>&1

    echo "=== [1/4] Actualizando sistema ==="
    apt-get update -y
    apt-get upgrade -y

    echo "=== [2/4] Instalando Docker ==="
    curl -fsSL https://get.docker.com | sh
    apt-get install -y docker-compose-plugin

    # Añadir ubuntu al grupo docker (para no necesitar sudo)
    usermod -aG docker ubuntu

    echo "=== [3/4] Instalando herramientas ==="
    apt-get install -y git curl wget jq unzip htop

    echo "=== [4/4] Preparando directorio del proyecto ==="
    mkdir -p /opt/devops-project
    chown ubuntu:ubuntu /opt/devops-project

    echo "=== Instalación completada ==="
    echo "Conectarse con: ssh -i TU_CLAVE.pem ubuntu@$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)"
    echo "Luego: cd /opt/devops-project && git clone TU_REPO . && cp .env.example .env"
  EOF
}

# ─── Instancia EC2 ────────────────────────────────────────────────────────────
resource "aws_instance" "devops" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  key_name               = var.key_pair_name
  vpc_security_group_ids = [aws_security_group.devops.id]

  # Disco raíz — 30 GB mínimo para las imágenes Docker del stack
  root_block_device {
    volume_type           = "gp3"      # Más rápido y barato que gp2
    volume_size           = var.root_volume_size_gb
    delete_on_termination = true
    encrypted             = true
  }

  user_data                   = local.user_data
  user_data_replace_on_change = false  # No recrear la instancia si cambias el script

  tags = {
    Name        = "devops-project"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ─── Elastic IP (IP fija que sobrevive reinicios) ─────────────────────────────
resource "aws_eip" "devops" {
  instance = aws_instance.devops.id
  domain   = "vpc"

  tags = {
    Name        = "devops-project-eip"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ─── Outputs ──────────────────────────────────────────────────────────────────
output "ec2_public_ip" {
  description = "IP pública fija de la instancia (Elastic IP)"
  value       = aws_eip.devops.public_ip
}

output "ec2_public_dns" {
  description = "DNS público de la instancia"
  value       = aws_instance.devops.public_dns
}

output "ec2_instance_id" {
  description = "ID de la instancia EC2"
  value       = aws_instance.devops.id
}

output "ssh_command" {
  description = "Comando SSH para conectarse a la instancia"
  value       = "ssh -i ${var.key_pair_name}.pem ubuntu@${aws_eip.devops.public_ip}"
}
