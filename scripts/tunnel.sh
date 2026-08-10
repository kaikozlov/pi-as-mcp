#!/usr/bin/env bash
# Repo-local wrapper for OpenAI tunnel-client. `run` and `doctor` load the
# gitignored tunnel/.env; informational tunnel-client subcommands do not.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -x bin/tunnel-client ]; then
	echo "bin/tunnel-client missing. Run: ./scripts/tunnel-install.sh" >&2
	exit 1
fi

case "${1:-}" in
	run|doctor)
		if [ ! -f tunnel/.env ]; then
			echo "tunnel/.env missing. Run: install -m 600 tunnel/.env.example tunnel/.env" >&2
			exit 1
		fi
		# Runtime API keys should never be group/world-readable. This is harmless
		# when the mode is already 0600 and fixes files created by a plain `cp`.
		chmod 600 tunnel/.env
		set -a
		# shellcheck disable=SC1091
		. ./tunnel/.env
		set +a
		if [ -z "${CONTROL_PLANE_TUNNEL_ID:-}" ]; then
			echo "CONTROL_PLANE_TUNNEL_ID is missing from tunnel/.env" >&2
			exit 1
		fi
		if [ -z "${CONTROL_PLANE_API_KEY:-}" ]; then
			echo "CONTROL_PLANE_API_KEY is missing from tunnel/.env" >&2
			exit 1
		fi
		if [ ! -f dist/index.js ]; then
			echo "dist/index.js missing. Run: npm install && npm run build" >&2
			exit 1
		fi
		exec ./bin/tunnel-client "$@" --profile-file ./tunnel/profile.yaml
		;;
	*)
		exec ./bin/tunnel-client "$@"
		;;
esac
