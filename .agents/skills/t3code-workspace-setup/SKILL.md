---
name: t3code-workspace-setup
description: >-
  Set up or debug reproducible T3 Code worktree initialization using t3.json
  scripts, dependencies, local env files and service isolation. Covers local
  worktree setup, not Orca's disposable VM or cloud environment recipes.
---

# T3 Code worktree setup

T3 has managed worktrees and project actions importable from `t3.json`. It does not expose Orca's
`environmentRecipes` or VM recipe doctor. For disposable cloud/VM lifecycle
provisioning, explain that gap instead of inventing a T3 equivalent. This skill
configures checkout initialization on the selected environment's host.

## Inspect existing ownership

Read the repo instructions, `t3.json`, setup scripts, package-manager lockfile,
env templates and development docs first. Check the actual working directory,
branch and worktree association. Reuse the existing setup path; do not create
a second installer or start setup twice while an earlier run still owns it.

Use the T3 worktree tools for managed creation or handoff when requested. New
worktrees start from committed history; uncommitted files and ignored secrets
are not automatically copied. Do not migrate a live database or server home
into a worktree by assumption.

## Configure the smallest setup

Preserve existing `t3.json` fields and scripts. A minimal setup entry looks like:

```json
{
  "$schema": "https://t3.codes/schema/t3.json",
  "scripts": [
    {
      "name": "Setup Worktree",
      "command": "node scripts/setup-worktree.mjs",
      "runOnWorktreeCreate": true,
      "async": false
    }
  ]
}
```

Create that script only if needed, using the repo's language and conventions.
Import the `t3.json` action in **Settings → Projects → Actions** for the intended
project and environment, or update its configured project actions through the
supported settings API. A committed `t3.json` alone does not register the action:
the setup runner uses resolved saved actions, including project overrides and
environment defaults. Check those before blaming the script. A handoff result
with `setupScript.status: 'no-script'` means no setup action was selected.

Commands run in the worktree. `T3CODE_PROJECT_ROOT` identifies the primary
project path; `T3CODE_WORKTREE_PATH` identifies the worktree when present.
Validate these before reading from another checkout. Quote paths and support
the shells/platforms the repository actually targets.

Setup is asynchronous by default, so the agent can start before it completes.
Use `async: false` when the agent must wait for dependencies or generated files.
If existing setup deliberately runs in the background, observe its completion
status before issuing another dependency install. Do not hide install failures
or fall back to silently rewriting the lockfile.

Reuse env templates and the established secret source. Preserve existing env
files; never overwrite them or commit credentials. Share a secret file only if
the project's policy allows it; isolate writable databases, generated state and
service resources per worktree. Do not symlink live writable state. Use actual
reported ports and avoid collisions rather than assuming a fixed port is free.

## Validate and report

Check the resulting configuration against the repository's `t3.json` schema and
run the setup in a disposable checkout when that test is within the request.
Verify the package manager's exit status, required generated files, environment
file presence without printing secrets, and the relevant startup/health check.
Run a second setup only if needed to prove it preserves existing user data.

Do not create a worktree solely to claim validation if the user did not request
one. Separate static review from an actual new-worktree run in the final report.
Report any remaining authentication, remote-host or platform prerequisites.
