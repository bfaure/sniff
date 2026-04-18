#!/bin/bash
set -e

echo "[sniff] Building..."

# Generate Prisma client
cd apps/backend
npx prisma generate
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
