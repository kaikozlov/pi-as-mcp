#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG="${CLOUDFLARED_CONFIG:-$HOME/.cloudflared/config.yml}"
PID_FILE="./server/cloudflared.pid"
LOG_FILE="./logs/cloudflared.log"

usage() {
	cat <<'USAGE'
Usage: ./scripts/cloudflare.sh <run|start|stop|status|logs>
Uses CLOUDFLARED_CONFIG or ~/.cloudflared/config.yml.
USAGE
}

pid_alive() {
	[ -f "$PID_FILE" ] || return 1
	local pid; pid="$(cat "$PID_FILE" 2>/dev/null || true)"
	[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

check() {
	command -v cloudflared >/dev/null || { echo "cloudflared not found" >&2; exit 1; }
	[ -f "$CONFIG" ] || { echo "Missing Cloudflare config: $CONFIG" >&2; exit 1; }
}

case "${1:-status}" in
	run)
		check; exec cloudflared tunnel --config "$CONFIG" run
		;;
	start)
		check; mkdir -p logs
		if pid_alive; then echo "cloudflared already running (pid $(cat "$PID_FILE"))"; exit 0; fi
		nohup cloudflared tunnel --config "$CONFIG" run >>"$LOG_FILE" 2>&1 </dev/null &
		pid=$!; echo "$pid" > "$PID_FILE"
		sleep 1
		kill -0 "$pid" 2>/dev/null || { echo "cloudflared exited during startup; see $LOG_FILE" >&2; rm -f "$PID_FILE"; exit 1; }
		echo "cloudflared started (pid $pid)"
		;;
	stop)
		if ! pid_alive; then echo "cloudflared is not running"; rm -f "$PID_FILE"; exit 0; fi
		pid="$(cat "$PID_FILE")"; kill "$pid"
		for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
		kill -0 "$pid" 2>/dev/null && { echo "cloudflared did not stop cleanly" >&2; exit 1; }
		rm -f "$PID_FILE"; echo "cloudflared stopped"
		;;
	status)
		check
		if pid_alive; then echo "process: running (pid $(cat "$PID_FILE"))"; else echo "process: not running"; fi
		cloudflared tunnel info "$(awk '/^tunnel:/ {print $2; exit}' "$CONFIG")" 2>/dev/null || true
		;;
	logs)
		touch "$LOG_FILE"; tail -n 100 -f "$LOG_FILE"
		;;
	*) usage >&2; exit 2 ;;
esac
