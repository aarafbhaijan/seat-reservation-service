#!/usr/bin/env bash
# One-command on-sale stampede: ./burst.sh <BASE_URL> [flags]   (see scripts/burst.ts)
# Example: ADMIN_API_KEY=... ./burst.sh https://13-233-45-67.sslip.io --total 20000
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm ci --no-audit --no-fund
# More file descriptors: thousands of concurrent sockets.
ulimit -n 65536 2>/dev/null || ulimit -n 10240 2>/dev/null || true
exec npx tsx scripts/burst.ts "$@"
