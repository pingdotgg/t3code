#!/bin/sh
set -eu
cd "$(dirname "$0")"
: "${1:?Usage: ./install.sh <phone IP shown in Pebble Dev Connection>}"
command -v pebble >/dev/null || { printf 'Install the Pebble SDK first.\n' >&2; exit 1; }
pebble build
pebble install --phone "$1"
