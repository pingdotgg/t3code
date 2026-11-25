#!/usr/bin/env bash
# Let Claude Code repair the fork after a failed Hardened release.
# Run by hardened-agent-change.yml in a job that holds no write credential. land-fix.sh checks
# the result and pushes it in a separate job.
#
# Usage: repair-release.sh <output-dir>
#   FAILED_LOG  file with the end of each failed release job's log
#   writes sync.bundle and summary.md to output-dir
#   sets resolved=true in GITHUB_OUTPUT when there is a fix to land
set -euo pipefail

TOOLS="$(cd "$(dirname "$0")" && pwd)"
source "$TOOLS/lib.sh"
OUT="$1"
LOG_COPY="release-failure.log"

mkdir -p "$OUT"
git config user.name "hyrmedia-t3code-sync[bot]"
git config user.email "hyrmedia-t3code-sync[bot]@users.noreply.github.com"
base="$(git rev-parse HEAD)"

cp "$FAILED_LOG" "$LOG_COPY"
run_agent <"$TOOLS/release-prompt.md" | tee "$OUT/summary.md"
rm "$LOG_COPY"

git add -u
if git diff --cached --quiet; then
  echo "The agent changed nothing. The release runs again as it is."
  exit 0
fi
git commit --quiet --no-verify -m "fix(hardened): repair the daily release

Claude Opus 5.5 via Claude Code."
git bundle create "$OUT/sync.bundle" HEAD "^$base"
echo "resolved=true" >>"${GITHUB_OUTPUT:-/dev/null}"
