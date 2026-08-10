#!/usr/bin/env bash
# Download the openai/tunnel-client binary into ./bin (self-contained; not committed).
# Re-run after cloning, or after bumping VERSION.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="v0.0.11"   # latest: https://github.com/openai/tunnel-client/releases/latest

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"          # darwin | linux
ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="amd64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
case "$OS" in
  darwin|linux) ;;
  *) echo "Unsupported OS: $OS (this installer handles darwin/linux)" >&2; exit 1 ;;
esac

mkdir -p bin
ASSET="tunnel-client-${VERSION}-${OS}-${ARCH}.zip"
URL="https://github.com/openai/tunnel-client/releases/download/${VERSION}/${ASSET}"
echo "Downloading $URL"
curl -fsSL -o "bin/$ASSET" "$URL"
unzip -o -j "bin/$ASSET" tunnel-client -d bin/ >/dev/null
rm -f "bin/$ASSET"
chmod +x bin/tunnel-client
echo "Installed tunnel-client $VERSION -> $(pwd)/bin/tunnel-client"
bin/tunnel-client --version
