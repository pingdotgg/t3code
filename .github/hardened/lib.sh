# shellcheck shell=bash
# Shared by the hardened sync and release repair scripts. Source it, do not run it.

UPSTREAM="https://github.com/pingdotgg/t3code.git"
READ_ONLY_GIT="Bash(git diff *),Bash(git log *),Bash(git show *),Bash(git status*),Bash(git apply --check *)"
# The agent job holds no credential, so vp can run any check that CI runs.
CHECKS="Bash(vp *),Bash(cd *),Bash(node --test *)"

fail() { echo "::error::$1"; exit 1; }

# run_agent: Claude Code reads the prompt on stdin, edits the working tree, and prints its report.
run_agent() {
  CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 claude -p --bare --restricted --strict-mcp-config \
    --no-session-persistence --model claude-opus-5-5 --effort high --max-budget-usd 25 \
    --tools "Read,Edit,Write,Glob,Grep,Bash" \
    --allowedTools "Read,Edit,Write,Glob,Grep,$READ_ONLY_GIT,$CHECKS"
}

# check_patch <commit>: the commit's hardened.patch must apply to the commit's own tree.
check_patch() {
  local index
  index="$(mktemp -u)"
  GIT_INDEX_FILE="$index" git read-tree "$1"
  git show "$1:.github/hardened/hardened.patch" | GIT_INDEX_FILE="$index" git apply --cached --check ||
    fail "hardened.patch does not apply to $1."
  rm -f "$index"
}

# push_and_wait_ci <commit> <branch>: push to a bot branch and wait for the CI run of that push.
# Sets CI_RUN. Returns nonzero when CI fails. Needs PUSH_TOKEN and GH_TOKEN.
push_and_wait_ci() {
  # Callers test this function, which turns off errexit inside it.
  git push --quiet --force "$PUSH_URL" "$1:refs/heads/$2" || fail "The push to $2 failed."
  CI_RUN=""
  for _ in {1..40}; do
    CI_RUN="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs?head_sha=$1&event=push&branch=$2" \
      --jq '.workflow_runs[] | select(.path == ".github/workflows/ci.yml") | .id' | head -n 1)"
    [[ -n "$CI_RUN" ]] && break
    sleep 15
  done
  [[ -n "$CI_RUN" ]] || fail "CI did not start for $2."
  gh run watch "$CI_RUN" --exit-status --interval 30 >/dev/null
}

# upsert_pr <base> <head> <title> <body-file>: one open pull request per head branch.
upsert_pr() {
  PR="$(gh pr list --head "$2" --state open --json url --jq '.[0].url // ""')"
  if [[ -n "$PR" ]]; then
    gh pr edit "$PR" --body-file "$4" >/dev/null
  else
    PR="$(gh pr create --base "$1" --head "$2" --title "$3" --body-file "$4")"
  fi
  echo "Pull request: $PR"
}
