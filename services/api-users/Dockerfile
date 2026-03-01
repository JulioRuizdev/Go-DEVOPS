# ─── Build stage ─────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# ─── Runtime stage ───────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Usuario no-root por seguridad
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

COPY --from=builder /app/node_modules ./node_modules
COPY --chown=appuser:appgroup . .

EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "src/index.js"]
