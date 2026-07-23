#!/usr/bin/env bash
set -euo pipefail

if ! command -v aws-nuke &>/dev/null; then
  echo "aws-nuke is not installed."
  echo "Install with: brew install ekristen/tap/aws-nuke"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/../aws-nuke-config.yml"

if grep -q '123456789012' "$CONFIG"; then
  echo "ERROR: You must replace the placeholder account ID in aws-nuke-config.yml"
  echo "Find your account ID with: aws sts get-caller-identity --query Account --output text"
  exit 1
fi

EXTRA_ARGS=("$@")

aws-nuke run \
  --config "$CONFIG" \
  --no-alias-check \
  "${EXTRA_ARGS[@]}"
