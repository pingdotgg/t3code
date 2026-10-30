#!/usr/bin/env bash
set -euo pipefail

# Usage: bash apps/server/scripts/seed-scheduled-task-worktree-fixture.sh [new-directory]
# Only creates a local Git fixture; register its project in an isolated T3 home.
fixture_root="${1:-$(mktemp -d /tmp/t3-scheduled-worktree.XXXXXX)}"
mkdir -p "$fixture_root"
fixture_root="$(cd "$fixture_root" && pwd -P)"
if [[ -e "$fixture_root/origin.git" || -e "$fixture_root/project" ]]; then
  printf 'Refusing to overwrite an existing fixture: %s\n' "$fixture_root" >&2
  exit 1
fi

git init --quiet --bare --object-format=sha1 --initial-branch=master "$fixture_root/origin.git"

# The fixture data is an empty tree with a fixed identity, timestamp and message.
# Reproduce the runtime evidence commit without depending on the caller's config.
fixture_tree="$(git --git-dir="$fixture_root/origin.git" hash-object -w -t tree --stdin </dev/null)"
fixture_commit="$(
  GIT_AUTHOR_NAME=Triage GIT_AUTHOR_EMAIL=triage@example.invalid \
    GIT_COMMITTER_NAME=Triage GIT_COMMITTER_EMAIL=triage@example.invalid \
    GIT_AUTHOR_DATE='2026-10-21T09:52:47+00:00' \
    GIT_COMMITTER_DATE='2026-10-21T09:52:47+00:00' \
    git --git-dir="$fixture_root/origin.git" -c commit.gpgsign=false commit-tree "$fixture_tree" -m fixture
)"
[[ "$fixture_commit" == 5cade2a196ef3c8da4151a9e8ced1c1b5a04c336 ]]
git --git-dir="$fixture_root/origin.git" update-ref refs/heads/master "$fixture_commit"
git clone --quiet --no-local "$fixture_root/origin.git" "$fixture_root/project"
git -C "$fixture_root/project" symbolic-ref --delete refs/remotes/origin/HEAD

git -C "$fixture_root/project" ls-remote --symref origin HEAD
git -C "$fixture_root/project" show-ref
if git -C "$fixture_root/project" show-ref --verify --quiet refs/remotes/origin/HEAD; then
  exit 1
fi

printf '\nFixture project: %s/project\nExpected child HEAD: %s\n' "$fixture_root" "$fixture_commit"
cat <<'SEQUENCE'

Actual isolated-server MCP sequence (use an agent thread in this fixture project):
1. schedule_task({title:"master-fixture", prompt:"Reply OK only. Do not edit files, run commands, or commit.", schedule:{type:"interval",everyMs:3600000}, bindToCurrentThread:false})
2. Record returned scheduledTaskId. Read isolated SQLite in read-only mode:
   scheduled_tasks.thread_id must be null; workspace_strategy_json must be
   {"type":"worktree","baseRef":"refs/remotes/origin/master","startFromOrigin":true}.
3. run_scheduled_task_now({taskId:<scheduledTaskId>}); record returned threadId.
4. Await the child's completed provider run. Its persisted userMessageId must
   reference the scheduledTaskId; its events must leave preparing and reach
   completed. Check the durable thread's worktreePath/branch against actual
   git worktree list --porcelain, symbolic-ref HEAD and rev-parse HEAD there.
   Child HEAD and project refs/remotes/origin/master must equal the SHA above.
5. delete_scheduled_task({scheduledTaskId:<scheduledTaskId>}); then
   list_scheduled_tasks({}) and a read-only scheduled_tasks query verify cleanup.

For explicit unbind, create a separate task with bindToCurrentThread:true;
record its nonnull thread_id and root strategy, verify origin/HEAD is absent,
then update_scheduled_task({scheduledTaskId:<id>,bindToCurrentThread:false}).
Repeat steps 2-5; the returned fresh thread must differ from the bound thread.
Scheduler lastRunStatus=succeeded alone does not prove workspace preparation.
SEQUENCE
