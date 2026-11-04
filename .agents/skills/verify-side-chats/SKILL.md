---
name: verify-side-chats
description: Verify T3 Learn side chats end to end in the web UI through T3's Browser panel. Use after any PR that changes side-chat behaviour, or to check that main still works.
---

# Verify T3 Learn side chats

Drive the real web app the way a learner does and prove each side-chat feature in `features/`. Mobile lists no side chats (D18), so it is out of scope.

## Launch

Only App's own thread uses the QA checkout. Children never start servers. Never point a server at `~/.t3/userdata`.

1. Take QA and load the commit as `/home/quokka/t3-learn-team/roles/app.md` rule 10 says (Holder line, `checkout --detach <sha>`, restart or `systemd-run`), and run `vp i` in the QA checkout.
2. Ready when `journalctl --user -u t3learn-qa-dev | grep dev-runner` prints `serverPort=… webPort=…` and both ports answer `curl`.
3. Pair with rule 10's `pair` command. Pass the `http://localhost:<webPort>/pair#token=…` URL only to `preview_open` or `preview_navigate`, and never write it anywhere else.

Another checkout can use `vp run dev` instead, as described in [test-t3-app](../test-t3-app/SKILL.md).

## Doctor

Read-only checks to run before the first drive and after anything surprising:

- `systemctl --user is-active t3learn-qa-dev.service` prints `active`.
- `ss -H -ltnp | grep -E ':(<serverPort>|<webPort>) '` shows both ports. `readlink /proc/<pid>/cwd` for each pid is inside the QA checkout.
- `git -C /home/quokka/.t3/projects/t3-sidechat-qa rev-parse HEAD` is the sha under test, and `git status --short` is empty.
- In the Browser panel the page title is `T3 Learn (Dev)` and the sidebar lists threads. A pairing page means you need a new token.

## Drive

Use the Browser panel tools (`preview_open`, `preview_navigate`, `preview_click`, `preview_type`, `preview_press`, `preview_upload`, `preview_wait_for`, `preview_evaluate`, `preview_snapshot`). Prefer the role and `aria-label` handles in the feature files. `preview_evaluate` output is the quickest way to read state, because snapshots of this app run past 20 KB.

Agent turns use the free `Replay (dev)` provider. The side-chat model picker offers its scenarios: `Showcase`, `Plan and reads`, `Write approval`, `Question` and `Multi turn`. Use Claude Haiku 4.5, chosen through Settings (feature 8), only for steer, the busy auto-finish case and HTML cards. Notes and summaries come from the text-generation model, so they work with Replay. The opening divider reads `Side chat context (summary unavailable)`.

`select` snippet: this is the proven way to raise the `Ask in side chat` toolbar. It selects part of one paragraph's text; whole-element and list-item selections didn't raise it in the 2026-11-04 run. Set `SCOPE` to `[aria-label="Conversation"]` for the lesson or `[aria-label="Side chat"]` for the open side chat, and set `PHRASE` to text nobody has asked about yet:

```js
(async () => {
  for (const m of document.querySelectorAll(`${SCOPE} [data-message-role="assistant"]`)) {
    const w = document.createTreeWalker(m, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) {
      const i = t.data.indexOf(PHRASE);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(t, i);
      r.setEnd(t, i + PHRASE.length);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      await new Promise((ok) => setTimeout(ok, 600));
      return [...document.querySelectorAll("button")].some(
        (b) => b.getAttribute("aria-label") === "Ask in side chat",
      );
    }
  }
  return "phrase not found";
})();
```

## Evidence

Write to `~/side-chat-e2e/verify/<date>-<sha>/`, outside the repo. For each feature, keep the `preview_evaluate` result that shows the end state and one `preview_snapshot` (`save: true`, then copy the PNG in). `result.md` has one row per feature: pass, fail or unreachable, plus what you observed. Clicks don't prove anything; reopen or reload and read the state.

## Cleanup

Put back the settings you changed (feature 8 **Restore**). Run `systemctl --user stop t3learn-qa-dev.service`, release the Holder line, and leave the evidence directory alone. Kill only PIDs you started; never kill by name.

## Run it

Doctor → features 1 to 11 in order (`features/README.md`) → `result.md`.

Keep it current: every PR that changes side-chat behaviour updates the matching feature file in the same PR. A periodic audit follows pstack's `maintain-verification-skill`.
