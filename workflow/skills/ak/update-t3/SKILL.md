---
name: update-t3
description: Update everything on all of Leo's machines in one go. Updates the provider CLIs, merges upstream into the fork, then rebuilds and restarts T3 Code. Only Leo starts it, with /update-t3.
disable-model-invocation: true
---

# Update T3 on every machine

Leo runs this to update everything at once. Do the whole run without asking; each step below says when to stop. Reply in Portuguese.

The machines are **distilo** (`ssh distilo`) and **omarchy** (this one, the last to restart). If Leo adds a machine, add it to this list.

## 1. Check the checkout

On omarchy, `~/Projects/T3/t3code` must be on `main` with no uncommitted changes (`git status --short --untracked-files=no`). If it has changes, stop and show them to Leo. Never stash or discard them.

## 2. Update the provider CLIs

Run [update-providers.sh](update-providers.sh) on every machine at the same time:

```sh
cd ~/Projects/T3/t3code/workflow/skills/ak/update-t3
bash -l ./update-providers.sh
ssh distilo 'bash -l -s' < update-providers.sh
```

The script picks the right updater for each machine. Mise-managed tools go through `mise upgrade`. Anything else uses its own updater (`claude update`, `grok update`, `opencode upgrade`). Running sessions keep their old binary until they restart. Report `FAILED:` lines, but carry on to step 3.

## 3. Update T3 Code, distilo first

`scripts/self-update.sh` does the git work, the build and the restart. It fast-forwards to origin/main, merges upstream/main, and pushes the merge. Main is published, so it merges and never rebases. It then runs `vp i`, builds, and restarts `t3code`. Run it through `systemd-run` so the restart can't kill it. Delete the old log first, or the wait can match the previous run's last line.

```sh
run='rm -f $HOME/.cache/t3code/source-update.log; systemd-run --user --unit t3code-source-update --collect --quiet --working-directory=$HOME/Projects/T3/t3code --setenv=T3CODE_SOURCE_UPDATE_SERVICE=t3code -p StandardOutput=truncate:$HOME/.cache/t3code/source-update.log $HOME/Projects/T3/t3code/scripts/self-update.sh'
ssh distilo "$run"
timeout 590 bash -c 'until ssh distilo "grep -E \"\[source-update\] (succeeded|failed)\" ~/.cache/t3code/source-update.log"; do sleep 10; done'
```

- **succeeded:** go on to omarchy.
- **failed, "does not merge cleanly":** merge on omarchy instead (`git fetch upstream && git merge upstream/main`). Resolve the conflicts so both sides' intent survives, run `vp run check:changed`, commit, and push to origin. Then run distilo again. Never push to upstream.
- **failed, anything else:** show Leo the end of `~/.cache/t3code/source-update.log`, which still runs the previous build. Stop there.

Then omarchy, last. This restart can cut off the current turn, so send Leo the report first (see step 4), with the omarchy result still marked as pending. Then start the update:

```sh
eval "$run"
```

If the turn survives, wait on `~/.cache/t3code/source-update.log` the same way, then confirm both machines are on the same commit with `git log -1 --oneline`.

## 4. Report

The report covers:

- each provider's old version and new version, per machine;
- the commit each machine ended on, and whether upstream brought anything new;
- anything that failed.

Pairing, the dev stack and the manual equivalent are in `t3code-update`.
