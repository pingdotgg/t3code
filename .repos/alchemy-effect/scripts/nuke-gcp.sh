# Account-wide teardown for GCP resources stamped with alchemy-* labels.
# Requires GOOGLE_PROJECT_ID and either GOOGLE_ACCESS_TOKEN or
# GOOGLE_APPLICATION_CREDENTIALS (a service-account JSON key).
set -euo pipefail

if [ -z "${GOOGLE_PROJECT_ID:-}" ] && [ -f "${HOME}/.config/gcloud/alchemy-project-id" ]; then
  export GOOGLE_PROJECT_ID="$(cat "${HOME}/.config/gcloud/alchemy-project-id")"
fi
if [ -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" ] && [ -f "${HOME}/.config/gcloud/alchemy-testing-sa.json" ]; then
  export GOOGLE_APPLICATION_CREDENTIALS="${HOME}/.config/gcloud/alchemy-testing-sa.json"
fi

bun alchemy unsafe nuke --config ./stacks/nuke-gcp.ts \
  --include 'GCP.*' \
  --profile alchemy-testing \
  --concurrency 16 \
  --timeout 300 \
  "$@"
