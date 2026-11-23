#!/usr/bin/env bash
set -euo pipefail

case "$1" in
  install)
    sudo apt-get update -qq
    sudo apt-get install -y -qq dbus xvfb xauth xdotool imagemagick libwebkit2gtk-4.1-0
    mkdir -p "$PROOF_ROOT"
    npm install --prefix "$PROOF_ROOT/tools" --no-save --no-audit --no-fund \
      "@open-pencil/cli@$PROOF_VERSION" "@open-pencil/mcp@$PROOF_VERSION"
    sudo ln -s "$PROOF_ROOT/tools/node_modules/.bin/openpencil-mcp-http" \
      /usr/local/bin/openpencil-mcp-http
    ;;
  extract)
    cd "$PROOF_ROOT"
    asset="OpenPencil_${PROOF_VERSION}_amd64.AppImage"
    curl -fsSL --retry 3 -o "$asset" \
      "https://github.com/open-pencil/open-pencil/releases/download/v$PROOF_VERSION/$asset"
    printf '%s  %s\n' "$PROOF_SHA" "$asset" | sha256sum --check
    chmod u+x "$asset"
    "./$asset" --appimage-extract > extract.log
    ;;
  *)
    printf 'Unknown release setup phase: %s\n' "$1" >&2
    exit 1
    ;;
esac
