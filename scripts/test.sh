#!/bin/bash
set -e

echo "[sniff] Running all tests..."

echo ""
echo "=== Unit Tests ==="
npx vitest run

echo ""
echo "=== Done ==="
