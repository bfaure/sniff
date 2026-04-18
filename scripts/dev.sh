#!/bin/bash
set -e

echo "[sniff] Starting development servers..."

# Kill any orphaned processes on our ports
lsof -ti:47120 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti:5173 2>/dev/null | xargs kill -9 2>/dev/null || true

# Start backend
echo "[sniff] Starting backend on :47120..."
cd apps/backend
npx tsx watch src/server.ts &
BACKEND_PID=$!
cd ../..

# Wait for backend
sleep 2

# Start renderer dev server
echo "[sniff] Starting renderer on :5173..."
cd apps/renderer
npx vite &
RENDERER_PID=$!
cd ../..

echo "[sniff] Dev servers running:"
echo "  Backend:  http://localhost:47120"
echo "  Renderer: http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop all servers"

trap "kill $BACKEND_PID $RENDERER_PID 2>/dev/null; exit" INT TERM
wait
