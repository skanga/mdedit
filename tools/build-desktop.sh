#!/usr/bin/env bash
# Stages the full web build for the Tauri shell. The shell ships the FULL
# build (Mermaid + KaTeX always available); the lite build stays web-only.
set -euo pipefail
cd "$(dirname "$0")/.."
./build.sh
rm -rf dist-desktop
mkdir -p dist-desktop
cp index.html dist-desktop/index.html
echo "staged dist-desktop/index.html"
