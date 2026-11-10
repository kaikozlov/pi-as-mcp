#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="./server/.env"
HTTP_PID_FILE="./server/pi-as-mcp-http.pid"
CLOUDFLARE_PID_FILE="./server/cloudflared.pid"
HTTP_LOG="./logs/http-server.log"
CLOUDFLARE_LOG="./logs/cloudflared.log"

usage() {
	cat <<'USAGE'
Usage: ./scripts/service.sh <start|stop|restart|status|logs>

Manage the Cloudflare-backed pi-as-mcp deployment.

Commands:
  start    Start the MCP HTTP server, then cloudflared
  stop     Stop cloudflared, then the MCP HTTP server
  restart  Restart both services
  status   Show local MCP health and Cloudflare tunnel state
  logs     Follow both service logs
USAGE
}

load_env() {
	[ -f "$ENV_FILE" ] || {
		echo "Missing $ENV_FILE. Run: bun run setup" >&2
		exit 1
	}
	chmod 600 "$ENV_FILE"
	set -a
	# shellcheck disable=SC1091
	. "$ENV_FILE"
	set +a
}

pid_alive() {
	local file="$1"
	[ -f "$file" ] || return 1
	local pid
	pid="$(cat "$file" 2>/dev/null || true)"
	[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

stop_pid() {
	local file="$1"
	local label="$2"
	if ! pid_alive "$file"; then
		echo "$label is not running"
		rm -f "$file"
		return 0
	fi
	local pid
	pid="$(cat "$file")"
	kill "$pid"
	for _ in $(seq 1 50); do
		kill -0 "$pid" 2>/dev/null || break
		sleep 0.1
	done
	if kill -0 "$pid" 2>/dev/null; then
		echo "$label did not stop cleanly" >&2
		return 1
	fi
	rm -f "$file"
	echo "$label stopped"
}

http_probe() {
	local host="${PI_MCP_HTTP_HOST:-127.0.0.1}"
	local port="${PI_MCP_HTTP_PORT:-3333}"
	curl -fsS "http://${host}:${port}/healthz"
}

http_start() {
	mkdir -p logs server
	if pid_alive "$HTTP_PID_FILE"; then
		echo "MCP HTTP server already running (pid $(cat "$HTTP_PID_FILE"))"
		http_probe
		printf '\n'
		return
	fi
	rm -f "$HTTP_PID_FILE"
	nohup bun ./src/index.ts --transport http >>"$HTTP_LOG" 2>&1 </dev/null &
	local pid=$!
	printf '%s\n' "$pid" > "$HTTP_PID_FILE"
	for _ in $(seq 1 50); do
		if ! kill -0 "$pid" 2>/dev/null; then
			echo "MCP HTTP server exited during startup; see $HTTP_LOG" >&2
			rm -f "$HTTP_PID_FILE"
			return 1
		fi
		local health
		health="$(http_probe 2>/dev/null || true)"
		if [ -n "$health" ]; then
			echo "MCP HTTP server started (pid $pid)"
			printf '%s\n' "$health"
			return
		fi
		sleep 0.1
	done
	echo "MCP HTTP server did not become healthy; see $HTTP_LOG" >&2
	return 1
}

cloudflare_config() {
	printf '%s\n' "${CLOUDFLARED_CONFIG:-$HOME/.cloudflared/config.yml}"
}

cloudflare_check() {
	command -v cloudflared >/dev/null || {
		echo "cloudflared not found" >&2
		return 1
	}
	local config
	config="$(cloudflare_config)"
	[ -f "$config" ] || {
		echo "Missing Cloudflare config: $config" >&2
		return 1
	}
}

cloudflare_start() {
	cloudflare_check
	mkdir -p logs server
	if pid_alive "$CLOUDFLARE_PID_FILE"; then
		echo "cloudflared already running (pid $(cat "$CLOUDFLARE_PID_FILE"))"
		return
	fi
	local config
	config="$(cloudflare_config)"
	nohup cloudflared tunnel --config "$config" run >>"$CLOUDFLARE_LOG" 2>&1 </dev/null &
	local pid=$!
	printf '%s\n' "$pid" > "$CLOUDFLARE_PID_FILE"
	sleep 1
	if ! kill -0 "$pid" 2>/dev/null; then
		echo "cloudflared exited during startup; see $CLOUDFLARE_LOG" >&2
		rm -f "$CLOUDFLARE_PID_FILE"
		return 1
	fi
	echo "cloudflared started (pid $pid)"
}

start_all() {
	load_env
	http_start
	if ! cloudflare_start; then
		echo "Cloudflare startup failed; stopping MCP HTTP server." >&2
		stop_pid "$HTTP_PID_FILE" "MCP HTTP server" || true
		return 1
	fi
}

stop_all() {
	local failed=0
	stop_pid "$CLOUDFLARE_PID_FILE" "cloudflared" || failed=1
	stop_pid "$HTTP_PID_FILE" "MCP HTTP server" || failed=1
	return "$failed"
}

status_all() {
	load_env
	local failed=0
	printf '%s\n' '==> MCP HTTP server'
	if pid_alive "$HTTP_PID_FILE"; then
		echo "process: running (pid $(cat "$HTTP_PID_FILE"))"
	else
		echo "process: not running"
		failed=1
	fi
	printf 'health: '
	if http_probe; then
		printf '\n'
	else
		echo "unavailable"
		failed=1
	fi

	printf '\n%s\n' '==> Cloudflare'
	if pid_alive "$CLOUDFLARE_PID_FILE"; then
		echo "process: running (pid $(cat "$CLOUDFLARE_PID_FILE"))"
	else
		echo "process: not running"
		failed=1
	fi
	if cloudflare_check; then
		local config tunnel_id
		config="$(cloudflare_config)"
		tunnel_id="$(awk '/^tunnel:/ {print $2; exit}' "$config")"
		if [ -n "$tunnel_id" ]; then
			cloudflared tunnel info "$tunnel_id" 2>/dev/null || failed=1
		fi
	else
		failed=1
	fi
	return "$failed"
}

follow_logs() {
	mkdir -p logs
	touch "$HTTP_LOG" "$CLOUDFLARE_LOG"
	exec tail -n 100 -f "$HTTP_LOG" "$CLOUDFLARE_LOG"
}

case "${1:-status}" in
	start)
		start_all
		;;
	stop)
		stop_all
		;;
	restart)
		stop_all
		start_all
		;;
	status)
		status_all
		;;
	logs)
		follow_logs
		;;
	help|-h|--help)
		usage
		;;
	*)
		echo "Unknown command: $1" >&2
		usage >&2
		exit 2
		;;
esac
