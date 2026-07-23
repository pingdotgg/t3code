#!/usr/bin/env bash
#
# Deletes API Gateway REST APIs one-by-one, retrying each delete indefinitely.
# Intended for severely throttled accounts (TooManyRequests) after test runs.
#
# Usage:
#   ./scripts/cleanup-apigateway-rest-apis.sh
#                       # deletes every REST API whose name contains "Ag" (adjust FILTER_QUERY)
#   ./scripts/cleanup-apigateway-rest-apis.sh /path/to/ids.txt
#                       # one rest-api-id per line
#
# Environment:
#   FILTER_QUERY               Override JMESPath for get-rest-apis (default matches `Ag`)
#   SLEEP_BETWEEN_APIS_SECONDS Pause after each successful delete (default 2)
#   AWS_PROFILE / AWS_REGION   Standard aws-cli
#

set -u

# Let this script own retry/backoff; each nested SDK retry wastes throttle tokens.
export AWS_MAX_ATTEMPTS=${AWS_MAX_ATTEMPTS:-1}
export AWS_RETRY_MODE=${AWS_RETRY_MODE:-standard}

FILTER_QUERY="${FILTER_QUERY:-items[?contains(name, \`Ag\`)].id}"

# AWS DeleteRestApi has a hard 30s/account throttle. Match it on the inner
# retry so we don't burn tokens with sub-30s backoff.
sleep_between_apis_seconds="${SLEEP_BETWEEN_APIS_SECONDS:-32}"
initial_retry_seconds="${INITIAL_RETRY_SECONDS:-32}"
max_retry_seconds="${MAX_RETRY_SECONDS:-120}"

ts() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

delete_one_until_ok() {
  local id="$1"
  local attempt=0

  [[ -z "$id" ]] && return

  local err
  while true; do
    attempt=$((attempt + 1))

    if err=$(aws apigateway delete-rest-api --rest-api-id "$id" 2>&1); then
      printf '%s deleted %s (attempt %d)\n' "$(ts)" "$id" "$attempt"
      return 0
    fi

    local wait_sec=$initial_retry_seconds
    if ((wait_sec > max_retry_seconds)); then
      wait_sec=$max_retry_seconds
    fi

    printf '%s delete %s failed; retry in %ds | %s\n' \
      "$(ts)" "$id" "$wait_sec" \
      "$(echo "$err" | tr '\n' ' ')" >&2

    sleep "$wait_sec"
  done
}

list_ids_from_aws() {
  aws apigateway get-rest-apis \
    --query "$FILTER_QUERY" \
    --output text \
    || die "get-rest-apis failed"
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    sed -n '1,25p' "$0"
    exit 0
  fi

  if [[ $# -ge 1 ]]; then
    local f="$1"
    [[ -f "$f" ]] || die "file not found: $f"

    printf 'Deleting IDs from %s (one api at a time, infinite retries per api)\n' "$f"

    while IFS= read -r id || [[ -n "${id:-}" ]]; do
      id="${id//$'\r'/}"
      id="${id//[$'\t ']/}"

      [[ -z "$id" ]] && continue
      printf 'next id: %s\n' "$id"
      delete_one_until_ok "$id"
      sleep "$sleep_between_apis_seconds"
    done <"$f"

    return 0
  fi

  printf '%s querying ids: %s\n' "$(ts)" "$FILTER_QUERY"

  local ids
  ids="$(list_ids_from_aws | tr '\t' '\n' | grep -v '^[[:space:]]*$' || true)"
  [[ -n "$ids" ]] || printf '%s No matching REST APIs.\n' "$(ts)"

  while IFS= read -r id || [[ -n "${id:-}" ]]; do
    id="${id//$'\r'/}"
    id="${id//[$'\t ']/}"

    [[ -z "$id" ]] && continue
    printf 'next id: %s\n' "$id"
    delete_one_until_ok "$id"
    sleep "$sleep_between_apis_seconds"
  done <<<"$ids"
}

main "$@"
