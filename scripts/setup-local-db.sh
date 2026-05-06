#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${1:-app}"
HOST="${PGHOST:-localhost}"

if [ "$HOST" != "localhost" ] && [ "$HOST" != "127.0.0.1" ]; then
  echo "Refusing to create databases on non-local host: $HOST" >&2
  exit 1
fi

if ! psql -h "$HOST" -Atc "select rolcreatedb from pg_roles where rolname = current_user" | grep -qx t; then
  echo "Current PostgreSQL role does not have CREATEDB." >&2
  exit 1
fi

for tier in dev stg prod; do
  db_name="${APP_NAME}_${tier}"
  if psql -h "$HOST" -lqt | cut -d '|' -f 1 | tr -d ' ' | grep -qx "$db_name"; then
    echo "$db_name exists"
  else
    createdb -h "$HOST" "$db_name"
    echo "$db_name created"
  fi
done
