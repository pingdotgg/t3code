#!/usr/bin/env bash
# Times one preview lifecycle: deploy -> URL live -> test -> destroy.
# Usage: ALCHEMY_PROFILE=<name> STAGE=<stage> bun run bench
# (STAGE defaults to pr-147; the CLI and the test harness both read ALCHEMY_PROFILE)
set -euo pipefail
cd "$(dirname "$0")/.."

export STAGE="${STAGE:-pr-147}"
unset CI # the test file only destroys on CI; this script destroys explicitly
mkdir -p .alchemy/bench
log=".alchemy/bench/$(date +%Y%m%d-%H%M%S)"

now() { date +%s.%N; }
elapsed() { awk -v s="$1" -v e="$2" 'BEGIN { printf "%.2fs", e - s }'; }

t0=$(now)
bunx alchemy deploy --stage "$STAGE" --yes >"$log-deploy.log" 2>&1 ||
  { cat "$log-deploy.log"; exit 1; }
t1=$(now)
echo "deploy   $(elapsed "$t0" "$t1")"

url=$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' "$log-deploy.log" | tail -1)
for _ in $(seq 1 100); do # at most ~10s
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$url/photos")" = 200 ] && break
  sleep 0.1
done
t2=$(now)
echo "url live $(elapsed "$t1" "$t2")  $url"

status=0
bun test >"$log-test.log" 2>&1 || { status=$?; cat "$log-test.log"; }
t3=$(now)
echo "test     $(elapsed "$t2" "$t3")"

bunx alchemy destroy --stage "$STAGE" --yes >"$log-destroy.log" 2>&1 ||
  { cat "$log-destroy.log"; exit 1; }
t4=$(now)
echo "destroy  $(elapsed "$t3" "$t4")"
echo "total    $(elapsed "$t0" "$t4")  (logs: $log-*.log)"
exit "$status"
