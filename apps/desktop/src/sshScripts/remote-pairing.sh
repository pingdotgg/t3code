set -eu
STATE_DIR="$HOME/.t3/ssh-launch/@@T3_STATE_KEY@@"
SERVER_HOME="$STATE_DIR/server-home"
RUNNER_FILE="$STATE_DIR/run-t3.sh"
mkdir -p "$STATE_DIR" "$SERVER_HOME"
cat >"$RUNNER_FILE" <<'SH'
@@T3_RUNNER_SCRIPT@@
SH
chmod 700 "$RUNNER_FILE"
"$RUNNER_FILE" auth pairing create --base-dir "$SERVER_HOME" --json
