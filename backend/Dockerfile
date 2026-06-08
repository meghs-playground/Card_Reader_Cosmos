# ── Stage 1: dependencies ────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --only=production

# ── Stage 2: Prisma generate ─────────────────────────────────────────────────
FROM node:20-alpine AS prisma
WORKDIR /app
RUN apk add --no-cache openssl
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY database/schema.prisma ./database/schema.prisma
RUN npx prisma generate --schema=database/schema.prisma

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
RUN apk add --no-cache openssl

# Create non-root user for security
RUN addgroup -g 1001 -S cosmos && adduser -u 1001 -S cosmos -G cosmos

COPY --from=prisma /app/node_modules ./node_modules
COPY --from=prisma /app/node_modules/.prisma ./node_modules/.prisma
COPY . .

# Create required directories with correct ownership
RUN mkdir -p uploads/incoming uploads/crops exports/output \
    && chown -R cosmos:cosmos /app

USER cosmos

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1

CMD npm run prisma:deploy && node database/seed.js && node server.js