---
name: ada-pull-requests
description: Open and merge pull requests on the Ada fork (jayleaton/ada).
---

- Use `-R jayleaton/ada` on every `gh` command. Never touch `pingdotgg/t3code`.
- Multi-PR features go on `feat/<name>`. Only its PR into `main` waits for the maintainer.
- Merge when required checks are green: `gh pr merge <n> -R jayleaton/ada --merge --match-head-commit <sha>`. Nightlies are not releases; only store or TestFlight submissions and stable tags need the maintainer.
- Failed "Agent context budget" on intended growth: add the `agent-context-increase` label.
- Rerun a failed job once; a second failure is real.
- After merging, remove the PR's clean worktree and branch.
