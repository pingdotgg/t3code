#!/usr/bin/env bash
# SYNTHETIC fixture builder for the archived Codex usage evidence (issue 7090).
# usage: make-fixture.sh <A|B|C|D1|D2|D3|D4> <root>
# Creates <root>/codex (fake CODEX_HOME), <root>/home (fake HOME) and
# <root>/t3/userdata/settings.json pointing the codex instance at the fixture.
set -euo pipefail
row=$1
root=$2
codex=$root/codex
mkdir -p "$codex/sessions" "$root/home" "$root/t3/userdata"
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# rollout <file> <sessionId> <input> <output> [total_tokens]
rollout() {
  local extra=""
  [ -n "${5:-}" ] && extra=",\"total_tokens\":$5"
  mkdir -p "$(dirname "$1")"
  printf '%s\n' \
    "{\"type\":\"session_meta\",\"timestamp\":\"$ts\",\"payload\":{\"id\":\"$2\",\"note\":\"SYNTHETIC fixture\"}}" \
    "{\"type\":\"turn_context\",\"timestamp\":\"$ts\",\"payload\":{\"model\":\"gpt-5.5\"}}" \
    "{\"type\":\"event_msg\",\"timestamp\":\"$ts\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":$3,\"output_tokens\":$4$extra}}}}" \
    >"$1"
}

active=$codex/sessions/2026/10/22/rollout-synthetic-a.jsonl
archived=$codex/archived_sessions/rollout-synthetic-b.jsonl
case $row in
  A) rollout "$active" synthetic-a 100 20 ;;
  B | D1 | D2 | D3 | D4)
    rollout "$active" synthetic-a 100 20
    rollout "$archived" synthetic-b 300 60
    ;;
  C) rollout "$archived" synthetic-b 300 60 ;;
  *) echo "unknown row $row" >&2 && exit 2 ;;
esac
case $row in
  # total_tokens below input+output fails the consistency check.
  D1) rollout "$codex/archived_sessions/rollout-synthetic-bad.jsonl" synthetic-bad 50 10 1 ;;
  D2) printf '{"type":"event_msg","payload":{"type":"token_count"\n' >"$codex/archived_sessions/rollout-synthetic-trunc.jsonl" ;;
  D3)
    rollout "$codex/archived_sessions/rollout-synthetic-locked.jsonl" synthetic-locked 999 1
    chmod 000 "$codex/archived_sessions/rollout-synthetic-locked.jsonl"
    ;;
  D4)
    rollout "$codex/archived_sessions/2026/rollout-synthetic-x.jsonl" synthetic-x 999 1
    chmod 000 "$codex/archived_sessions/2026"
    ;;
esac

# enabled:false still scans usage but never probes or spawns the codex CLI.
cat >"$root/t3/userdata/settings.json" <<JSON
{"providerInstances":{"codex":{"driver":"codex","enabled":false,"config":{"homePath":"$codex","shadowHomePath":""}}}}
JSON
