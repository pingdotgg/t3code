#!/usr/bin/env bash
set -euo pipefail

MIN_PORT=10000
PORT_LABELS=()
PORT_VALUES=()

usage() {
  cat <<'EOF'
Validate explicit local-development port assignments.

Usage:
  bash scripts/check-port-policy.sh --port <service>=<port> [--port <service>=<port> ...]

Options:
  --port <service>=<port>  Add a named service port to validate (repeatable)
  -h, --help               Show this help

Examples:
  bash scripts/check-port-policy.sh --port app=12000 --port api=12001
EOF
}

push_port() {
  local assignment="$1"
  local service="${assignment%%=*}"
  local port="${assignment#*=}"

  if [[ "$assignment" != *=* || -z "$service" || -z "$port" ]]; then
    echo "[port-policy] --port must use <service>=<port> format." >&2
    exit 1
  fi

  if [[ ! "$service" =~ ^[a-zA-Z][a-zA-Z0-9_-]*$ ]]; then
    echo "[port-policy] Invalid service name: $service" >&2
    exit 1
  fi

  if [[ ! "$port" =~ ^[0-9]+$ ]]; then
    echo "[port-policy] Port for '$service' must be numeric." >&2
    exit 1
  fi

  if (( port < MIN_PORT )); then
    echo "[port-policy] Port for '$service' must be >= $MIN_PORT; received $port." >&2
    exit 1
  fi

  if (( port > 65535 )); then
    echo "[port-policy] Port for '$service' must be <= 65535; received $port." >&2
    exit 1
  fi

  local index=0
  for existing_port in "${PORT_VALUES[@]:-}"; do
    if [[ "$existing_port" == "$port" ]]; then
      local existing_service="${PORT_LABELS[$index]}"
      echo "[port-policy] Duplicate port '$port' for '$service' and '$existing_service'." >&2
      exit 1
    fi
    index=$((index + 1))
  done

  PORT_LABELS+=("$service")
  PORT_VALUES+=("$port")
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      if [[ -z "${2:-}" || "${2:-}" == --* ]]; then
        echo "[port-policy] --port requires a <service>=<port> value." >&2
        exit 1
      fi
      push_port "$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[port-policy] Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ "${#PORT_VALUES[@]}" -eq 0 ]]; then
  echo "[port-policy] At least one explicit --port assignment is required." >&2
  usage
  exit 1
fi
