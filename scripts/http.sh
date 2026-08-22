#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="./server/.env"
PID_FILE="./server/pi-as-mcp-http.pid"
CONSOLE_LOG="./logs/http-server.log"

usage() {
	cat <<'USAGE'
Usage: ./scripts/http.sh <command> [pi-mcp args...]

Commands:
  run      Run Streamable HTTP MCP in the foreground
  start    Start it persistently in the background
  stop     Stop the background server
  status   Show process state and probe local /healthz
  logs     Tail the server console log
  help     Show this help
USAGE
}

ensure_build() {
	local stale=false
	[ -f dist/index.js ] || stale=true
	for f in src/*.ts package.json; do
		[ "$f" -nt dist/index.js ] && stale=true && break
	done
	if [ "$stale" = true ]; then bun run build >&2; fi
}

load_env() {
	[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE; copy server/.env.example and configure it." >&2; exit 1; }
	chmod 600 "$ENV_FILE"
	set -a
	# shellcheck disable=SC1091
	. "$ENV_FILE"
	set +a
}

pid_alive() {
	[ -f "$PID_FILE" ] || return 1
	local pid; pid="$(cat "$PID_FILE" 2>/dev/null || true)"
	[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

probe() {
	local host="${PI_MCP_HTTP_HOST:-127.0.0.1}"
	local port="${PI_MCP_HTTP_PORT:-3333}"
	curl -fsS "http://${host}:${port}/healthz"
	printf '\n'
}

command="${1:-help}"
if [ "$#" -gt 0 ]; then shift; fi
case "$command" in
	run)
		ensure_build; load_env
		exec node ./dist/index.js --transport http "$@"
		;;
	start)
		ensure_build; load_env
		mkdir -p logs
		if pid_alive; then echo "HTTP MCP already running (pid $(cat "$PID_FILE"))"; probe; exit 0; fi
		rm -f "$PID_FILE"
		nohup node ./dist/index.js --transport http "$@" >>"$CONSOLE_LOG" 2>&1 </dev/null &
		pid=$!; printf '%s\n' "$pid" > "$PID_FILE"
		for _ in $(seq 1 50); do
			if ! kill -0 "$pid" 2>/dev/null; then echo "HTTP MCP exited during startup; see $CONSOLE_LOG" >&2; rm -f "$PID_FILE"; exit 1; fi
			health="$(probe 2>/dev/null || true)"
			if [ -n "$health" ]; then echo "HTTP MCP started (pid $pid)"; printf '%s\n' "$health"; exit 0; fi
			sleep 0.1
		done
		echo "HTTP MCP did not become healthy; see $CONSOLE_LOG" >&2; exit 1
		;;
	stop)
		if ! pid_alive; then echo "HTTP MCP is not running"; rm -f "$PID_FILE"; exit 0; fi
		pid="$(cat "$PID_FILE")"; kill "$pid"
		for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
		kill -0 "$pid" 2>/dev/null && { echo "HTTP MCP did not stop cleanly" >&2; exit 1; }
		rm -f "$PID_FILE"; echo "HTTP MCP stopped"
		;;
	status)
		load_env
		if pid_alive; then echo "process: running (pid $(cat "$PID_FILE"))"; else echo "process: not running"; fi
		printf 'health: '; probe
		;;
	logs)
		touch "$CONSOLE_LOG"; tail -n 100 -f "$CONSOLE_LOG"
		;;
	help|-h|--help) usage ;;
	*) echo "Unknown command: $command" >&2; usage >&2; exit 2 ;;
esac
