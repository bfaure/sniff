#!/bin/bash
set -e

echo "[sniff] Building..."

# Generate Prisma client
cd apps/backend
npx prisma generate
echo "[sniff] Generating schema.sql for packaged DB initialization..."
npx prisma migrate diff --from-empty --to-schema-datamodel ./prisma/schema.prisma --script > prisma/schema.sql
cd ../..

# Build shared package
cd packages/shared
npx tsc
cd ../..

# Build backend
cd apps/backend
npx tsc
cd ../..

# Build renderer
cd apps/renderer
npx vite build
cd ../..

# Build electron
cd apps/electron
npx tsc
cd ../..

echo "[sniff] Build complete"
