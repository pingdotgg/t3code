#!/usr/bin/env bash
# Usage: seed-all.sh <checkout> <home>  (dev server for <home> must be stopped)
set -euo pipefail
cd "$1"; H="$2"
S() { node apps/server/scripts/usage-limit-web-evidence-seed.ts --home "$H" "$@" | grep '"kind":"shell"' | cut -c1-300; }
S --row W0 --stage init --title "W0 limited, no wake"
S --row W1 --stage init --title "W1 wake completed before reset"; S --row W1 --stage wake
S --row W2 --stage init --arm --title "W2 armed, wake completed before reset"; S --row W2 --stage wake
S --row W4 --stage init --title "W4 resume after wake"; S --row W4 --stage wake
S --row W5 --stage init --arm --reset-delay-ms "${W5_DELAY:-540000}" --title "W5 armed, crosses reset"; S --row W5 --stage wake
S --row W8 --stage init --title "W8 user turn before reset"; S --row W8 --stage user
S --row W7 --stage init --reset-delay-ms 20000 --title "W7 wake completed after reset"
sleep 23; S --row W7 --stage wake
