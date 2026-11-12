#!/usr/bin/env bash
set -euo pipefail
tests_dir=$(cd "$(dirname "$0")" && pwd)
"${GRADLE:-gradle}" --project-dir "$tests_dir/android" test "$@"
