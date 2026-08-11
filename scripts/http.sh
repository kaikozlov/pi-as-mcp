#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="./server/.env"

usage() {
	cat <<'EOF'
Usage: ./scripts/http.sh <command> [pi-mcp args...]

Commands:
  run      Build if stale, load server/.env, and run Streamable HTTP MCP
  status   Probe the local /healthz endpoint
  help     Show this help
EOF
}

ensure_build() {
	if [ ! -f dist/index.js ] || [ src/index.ts -nt dist/index.js ] || [ src/tools.ts -nt dist/index.js ] || [ src/cloudflare-auth.ts -nt dist/index.js ]; then
		bun run build >&2
	fi
}

load_env() {
	[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE; run: bun run setup" >&2; exit 1; }
	chmod 600 "$ENV_FILE"
	set -a
	# shellcheck disable=SC1091
	. "$ENV_FILE"
	set +a
}

command="${1:-help}"
if [ "$#" -gt 0 ]; then shift; fi
case "$command" in
	run|start)
		ensure_build
		load_env
		exec node ./dist/index.js --transport http "$@"
		;;
	status)
		load_env
		host="${PI_MCP_HTTP_HOST:-127.0.0.1}"
		port="${PI_MCP_HTTP_PORT:-3333}"
		curl -fsS "http://${host}:${port}/healthz"
		printf '\n'
		;;
	help|-h|--help)
		usage
		;;
	*)
		echo "Unknown command: $command" >&2
		usage >&2
		exit 2
		;;
esac
