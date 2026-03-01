#!/bin/bash
# ─── Configuración de Kong vía Admin API ──────────────────────────────────────
# Ejecutar DESPUÉS de que Kong esté corriendo: bash kong/setup-kong.sh

KONG_ADMIN="http://localhost:8001"

echo "🦍 Configurando Kong API Gateway..."

# ─── SERVICIOS ────────────────────────────────────────────────────────────────
echo "Registrando servicios..."

curl -s -X POST $KONG_ADMIN/services \
  --data name=users-service \
  --data url=http://api-users:3001 | jq .

curl -s -X POST $KONG_ADMIN/services \
  --data name=products-service \
  --data url=http://api-products:3002 | jq .

curl -s -X POST $KONG_ADMIN/services \
  --data name=files-service \
  --data url=http://api-files:3004 | jq .



# ─── RUTAS ────────────────────────────────────────────────────────────────────
echo "Registrando rutas..."

curl -s -X POST $KONG_ADMIN/services/users-service/routes \
  --data "paths[]=/api/users" \
  --data "strip_path=false" \
  --data "name=users-route" | jq .

curl -s -X POST $KONG_ADMIN/services/products-service/routes \
  --data "paths[]=/api/products" \
  --data "strip_path=false" \
  --data "name=products-route" | jq .

curl -s -X POST $KONG_ADMIN/services/files-service/routes \
  --data "paths[]=/api/files" \
  --data "strip_path=false" \
  --data "name=files-route" | jq .

# Aumentar límite de body para subida de archivos (50MB)
curl -s -X POST $KONG_ADMIN/services/files-service/plugins \
  --data "name=request-size-limiting" \
  --data "config.allowed_payload_size=50" \
  --data "config.size_unit=megabytes" | jq .

# JWT requerido en files también
curl -s -X POST $KONG_ADMIN/services/files-service/plugins \
  --data "name=jwt" | jq .



# ─── PLUGINS GLOBALES ─────────────────────────────────────────────────────────
echo "Configurando plugins..."

# Rate Limiting (usa Redis como store)
curl -s -X POST $KONG_ADMIN/plugins \
  --data "name=rate-limiting" \
  --data "config.minute=100" \
  --data "config.hour=1000" \
  --data "config.policy=redis" \
  --data "config.redis_host=redis" \
  --data "config.redis_port=6379" \
  --data "config.redis_password=${REDIS_PASSWORD:-redispass}" | jq .

# CORS
curl -s -X POST $KONG_ADMIN/plugins \
  --data "name=cors" \
  --data "config.origins=*" \
  --data "config.methods=GET,POST,PUT,PATCH,DELETE,OPTIONS" \
  --data "config.headers=Accept,Authorization,Content-Type" \
  --data "config.exposed_headers=X-Auth-Token" \
  --data "config.max_age=3600" | jq .

# Request Logging
curl -s -X POST $KONG_ADMIN/plugins \
  --data "name=file-log" \
  --data "config.path=/tmp/kong-access.log" | jq .

# Prometheus metrics
curl -s -X POST $KONG_ADMIN/plugins \
  --data "name=prometheus" | jq .

# JWT Auth en el servicio de orders (requiere token)
curl -s -X POST $KONG_ADMIN/services/orders-service/plugins \
  --data "name=jwt" | jq .

echo "✅ Kong configurado exitosamente!"
echo ""
echo "Rutas disponibles:"
echo "  GET  http://localhost/api/users"
echo "  GET  http://localhost/api/products"
echo "  GET  http://localhost/api/orders  (requiere JWT)"
