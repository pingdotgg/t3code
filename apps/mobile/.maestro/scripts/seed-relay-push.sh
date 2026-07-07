#!/usr/bin/env bash
# Trigger staging agent-awareness push for Maestro / manual E2E.
# Step s14 implements full relay test hook; this stub documents requirements.
set -euo pipefail

RELAY_STAGING_URL="${RELAY_STAGING_URL:-}"
RELAY_TEST_DEVICE_ID="${RELAY_TEST_DEVICE_ID:-}"

if [[ -z "$RELAY_STAGING_URL" || -z "$RELAY_TEST_DEVICE_ID" ]]; then
  echo "seed-relay-push: set RELAY_STAGING_URL and RELAY_TEST_DEVICE_ID" >&2
  echo "See scratch/android-parity/STAGING-RUNBOOK.md" >&2
  exit 1
fi

echo "seed-relay-push: POST waiting_for_approval to $RELAY_STAGING_URL for device $RELAY_TEST_DEVICE_ID"
echo "Implement relay test publish endpoint in step s14 — stub exits 0 for CI skip until then"
exit 0