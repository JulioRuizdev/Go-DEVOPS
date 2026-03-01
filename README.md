# 🚀 DevOps Practice Project

Stack: **Kong API Gateway + ModSecurity WAF + PostgreSQL + Redis + 3 Microservicios + CI/CD**

## Arquitectura

```
Internet
    │
    ▼
┌─────────────────────────────┐
│  WAF - ModSecurity/NGINX    │  :80  (OWASP CRS Rules)
│  Bloquea: SQLi, XSS, LFI   │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│    Kong API Gateway         │  :8000 (proxy) / :8001 (admin)
│  Rate Limiting, JWT, CORS   │
│  Logging, Prometheus        │
└──────┬───────┬──────┬───────┘
       │       │      │
       ▼       ▼      ▼
  api-users  api-products  api-orders
  :3001      :3002         :3003
       │       │      │
       └───────┴──────┘
               │
       ┌───────┴───────┐
       │               │
  PostgreSQL         Redis
  (4 DBs)          (Cache + Rate limit store)
```

## Setup Rápido

```bash
# 1. Clonar e inicializar
git clone <repo>
cd devops-project
cp .env.example .env
# Editar .env con tus valores

# 2. Levantar infraestructura
docker compose up -d postgres redis
sleep 10  # Esperar que BD inicie

# 3. Levantar Kong (las migrations corren automáticamente)
docker compose up -d kong konga

# 4. Levantar WAF y microservicios
docker compose up -d --build

# 5. Configurar rutas y plugins en Kong
chmod +x kong/setup-kong.sh
bash kong/setup-kong.sh

# 6. Levantar monitoreo
docker compose up -d prometheus grafana
```

## URLs de Acceso

| Servicio     | URL                        | Descripción              |
|--------------|----------------------------|--------------------------|
| API (via WAF)| http://localhost/api/users | Punto de entrada público |
| Kong Admin   | http://localhost:8001      | Admin API (solo interno) |
| Konga UI     | http://localhost:1337      | Dashboard visual Kong    |
| Grafana      | http://localhost:3000      | Métricas y dashboards    |
| Prometheus   | http://localhost:9090      | Métricas raw             |

## CI/CD - GitHub Actions Secrets necesarios

```
DOCKERHUB_USERNAME   → tu usuario de DockerHub
DOCKERHUB_TOKEN      → token de acceso DockerHub
DROPLET_HOST         → IP de tu Droplet
DROPLET_USER         → usuario SSH (root o deploy)
DROPLET_SSH_KEY      → clave privada SSH
SLACK_WEBHOOK        → (opcional) notificaciones Slack
```

## Comandos útiles

```bash
# Ver logs de Kong
docker compose logs -f kong

# Ver logs del WAF (peticiones bloqueadas)
docker exec waf tail -f /var/log/modsec_audit.log

# Resetear rate limiting en Redis
docker exec redis redis-cli -a $REDIS_PASSWORD FLUSHDB

# Escalar un microservicio
docker compose up -d --scale api-products=3

# Ver estado de todos los contenedores
docker compose ps
```

## Próximos pasos para practicar

- [ ] Agregar autenticación OAuth2 con Kong + Keycloak
- [ ] Configurar SSL/TLS con Let's Encrypt
- [ ] Implementar circuit breaker con Kong
- [ ] Agregar trazabilidad con Jaeger (OpenTelemetry)
- [ ] Pipeline de infraestructura con Terraform en el Droplet
- [ ] Configurar backup automático de PostgreSQL
