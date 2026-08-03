#!/usr/bin/env bash
set -euo pipefail

# Named volumes can be created with root ownership. Only fix their mount roots:
# recursively walking a populated workspace would make every startup expensive
# and could rewrite ownership chosen by the user inside the environment.
mkdir -p /home/t3 /workspace
chown t3:t3 /home/t3 /workspace

exec gosu t3 "$@"
