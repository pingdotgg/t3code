Scratch evidence for issue 30662, round 2. NOT for the PR: upload these, then drop this commit.

Device: Android emulator Pixel 9 (API 36, 1080x2424, font scale default), T3 Code dev client
(fingerprint aba84043), animations off, theme per row label. Fresh dev DB (T3CODE_DEV_SEED=0),
environment default thread mode = New worktree (settings.json defaultThreadEnvMode=worktree).
Fixture projects (synthetic): unborn-repo = `git init -b main` + one untracked file, no commit;
detached-repo = one commit on branch feature-x, then `git checkout --detach`;
normal-repo = one commit on main.
Driver: capture-driver.sh <session> <out> <label> <project> <light|dark> (settled = two identical
frames 500 ms apart below the status bar).
Diffs: *-diff0 = fuzz 0 (any changed pixel red), *-diff5 = fuzz 5%. Pixel counts below status bar:
unborn-dark 67640, unborn-light 67631, detached-dark 71601 (hint line + hero re-centred upward),
normal-dark 1588 (5px strip = sub-pixel anti-aliasing of the hero project-name underline only).
Before = 8b44f42b14 (main), after = 4f1cdfd878.
