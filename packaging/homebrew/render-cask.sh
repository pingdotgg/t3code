#!/usr/bin/env bash
# Renders the Continuum IDE Homebrew cask.
# Usage: render-cask.sh VERSION ARM64_SHA256 X64_SHA256 [URL_BASE] > continuum-ide.rb
# URL_BASE defaults to this version's GitHub release; tests pass a file:// folder instead.
set -euo pipefail
version="$1"; arm="$2"; x64="$3"
base="${4:-https://github.com/SwashX-dev/continuum-ide/releases/download/v#{version}}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "bad version: $version" >&2; exit 1; }
[[ "$arm" =~ ^[0-9a-f]{64}$ && "$x64" =~ ^[0-9a-f]{64}$ ]] || { echo "bad sha256" >&2; exit 1; }
template="$(dirname "$0")/continuum-ide.rb.template"
sed -e "s|@VERSION@|${version}|" -e "s|@ARM_SHA256@|${arm}|" -e "s|@X64_SHA256@|${x64}|" \
    -e "s|@URL_BASE@|${base}|" "$template"
