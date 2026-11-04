---
name: verify-side-chats
description: Verify T3 Learn side chats through the web UI in T3's Browser panel after any PR that changes side-chat behaviour, or to check main.
---

# Verify T3 Learn side chats

Use this skill to prove T3 Learn side chats end to end in the real web UI. Read `features/README.md`, then run the features in order. The mobile app shows no side chats (D18); mobile is out of scope here.

## Launch

The parent verification thread owns the QA checkout and Browser panel. Never start a server in a child or run against `~/.t3/userdata`.

1. Read the Holder line in `/home/quokka/t3-learn-team/STATE.md`. In the QA checkout, load the SHA under test:
   `git -C /home/quokka/.t3/projects/t3-sidechat-qa checkout --detach <sha>`.
2. Restart the QA server: `systemctl --user restart t3learn-qa-dev.service`.
   If it is not loaded, run `systemctl --user reset-failed t3learn-qa-dev.service`, then:
   `systemd-run --user --collect --unit=t3learn-qa-dev -p MemoryMax=6G -p MemorySwapMax=0 -p WorkingDirectory=/home/quokka/.t3/projects/t3-sidechat-qa --setenv=T3CODE_DEV_SEED=0 --setenv=PATH="$PATH" /home/quokka/.local/share/vite-plus/bin/vp run dev`.
3. Read the actual ports: `journalctl --user -u t3learn-qa-dev | grep dev-runner`.
4. Pair from the QA checkout with:
   `env -u T3CODE_HOME -u T3_BOOT_SERVICE_UNIT -u T3_SERVICE_LAUNCHER_CONTEXT node apps/server/src/bin.ts pair --base-dir /home/quokka/.t3/projects/t3-sidechat-qa/.t3`.
   Put the resulting URL only into `preview_navigate`.
5. Any other checkout may use `vp run dev` as documented by `test-t3-app`; never use the live userdata directory.

The free `Replay (dev)` provider is the default for agent turns: use `preview_evaluate` with `window.t3dev.replay("showcase")`, or the `thread start --provider devReplay --model showcase` command from `test-t3-app`. The showcase transcript has no side-chat opening-summary or note-writing scenario. For those assertions, use Claude Haiku only when the live run needs real text generation; otherwise record the visible fallback (`The lesson summary is unavailable.` / `No note needed` or `Couldn't write the note`) and why. `sideChatOpening.ts` and `SideChatOpeningService.ts` wait at most `SIDE_CHAT_WAIT_CAP_MS` (15 seconds); notes use the same cap after Done or send (`notes.ts`/`SideChatLifecycleService.ts`).

## Doctor

Run one read-only check before driving: `systemctl --user is-active t3learn-qa-dev.service; ss -H -ltnp; git -C /home/quokka/.t3/projects/t3-sidechat-qa rev-parse HEAD; read `/proc/<web-or-server-pid>/cwd`from the PIDs shown by`ss`and require the QA checkout and requested SHA. In the Browser panel,`preview_snapshot`must show the signed-in T3 Learn app. If any check fails, stop and record the reason in`result.md`.

## Drive

Call `preview_status` first. If no automation-capable tab is attached, call `preview_open`; navigate once with the complete pairing URL, then keep that tab. Use `preview_snapshot` to obtain current handles and `preview_click`, `preview_type`, `preview_press`, `preview_select`, `preview_evaluate`, `preview_wait_for`, `preview_hover`, `preview_drag`, and `preview_scroll` for actions. Prefer the exact ARIA handles in the feature files; do not use coordinates or internal setters.

## Evidence

For every feature, capture one screenshot and one ARIA snapshot after the action and resulting state with `preview_snapshot`, under `~/side-chat-e2e/verify/<date>-<sha>/`. Record feature, entry point, pass/fail, and reason in `result.md`. A click alone is not proof: reopen or refresh to prove persistence, note delivery, finished state, or the rendered card/media. Keep evidence outside the repository.

## Cleanup

Preserve the evidence directory. Stop only the QA unit you started with `systemctl --user stop t3learn-qa-dev.service`; never kill by process name and never delete evidence. Release the QA Holder line in `STATE.md`. The parent thread performs launch, doctor, live proof, and cleanup; this generated skill is the recipe it follows.

## Run it

doctor → features 1→11 → `result.md`

Keeping it current: every PR that changes side-chat behaviour updates the matching feature file (pstack `maintain-verification-skill`).
