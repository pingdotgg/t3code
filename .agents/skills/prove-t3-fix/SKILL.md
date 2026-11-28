---
name: prove-t3-fix
description: Prove a T3 Code bug fix in the real app with an e2e scenario that fails on the base commit and passes on the fix, and get the before/after captures for the PR. Use when fixing a bug a user can reproduce in the web or iOS app, when a PR needs real-app proof or before/after screenshots, and when a scenario under scripts/scenarios fails.
---

# Prove a T3 fix

A scenario is one [e2e](https://e2e.com/docs) test in `scripts/scenarios` that
drives the real app on the free Replay agent. `vp run scenarios:prove` runs it
on a base commit and on the fix, and the `proof.md` it writes is the PR's
evidence. The rules a scenario follows are in
[15_testing.md](../../../docs/internals/15_testing.md#scenarios).

`pnpm --dir scripts exec e2e guide <topic>` prints the runner's own guide:
`writing-tests` for locators and matchers, `mcp` for live sessions, `debugging`
for error codes. Skip everything it says about `agent.*` steps and models:
scenarios configure no model.

Write the scenario before the fix, so you see it fail for the bug's reason.

## 1. Seed the state

Copy the closest scenario in `scripts/scenarios` to
`scripts/scenarios/<what-stays-true>.e2e.ts` and keep only its arrange part:
`t3.project`, `t3.thread`, and `t3.open` from [t3.ts](../../../scripts/scenarios/t3.ts)
(web) or [t3-mobile.ts](../../../scripts/scenarios/t3-mobile.ts) (iOS).

```ts
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test("A sent message keeps its leading spaces", WEB, async ({ t3, app, screen }) => {
  const project = await t3.project("demo");
  const thread = await t3.thread({ project, title: "Outline", messages: ["Start"] });
  await t3.open(thread);
  await screen.getByRole("textbox").waitFor();
});
```

End the seed with a `waitFor()` on something the loaded screen shows, so the
next step starts after the app has rendered. Keep `expect` for the behavior the
bug breaks.

An iOS scenario imports `IOS` and `test` from `t3-mobile.ts` and runs on
`ios` wherever the steps below say `web`. That target leases a Simlock
simulator, so it needs `SIMLOCK_AGENT_DEVICE_URL` and
`AGENT_DEVICE_DAEMON_AUTH_TOKEN`. Without them, say the device proof is missing.

## 2. Walk the flow

With the `e2e` MCP server, open a session on that file:
`open_session {target: "web", test: "scenarios/<name>.e2e.ts"}`. It runs the
seed and leaves you on that screen, signed in. A session without `test` is
signed out and has no project. Then `observe`, act (`tap`, `type`, `press`),
and try a locator with `locate` before you write it. Each action answers with
the test line that repeats it, and `test_lines` prints them all. Call
`close_session` when you have the lines.

The server only starts when dependencies were installed before the agent
session began. Without its tools, write the steps from the closest scenario and
the component's accessible names, and let the run in step 3 correct them.

End with the `expect` the bug breaks, and take `app.screenshot("label")` just
before it, where the bug shows.

## 3. Run it until it fails for the right reason

```sh
E2E_TELEMETRY_DISABLED=1 pnpm --dir scripts exec e2e run scenarios/<name>.e2e.ts --target web --action-timeout 5000
```

On the unfixed code the run must end in `ASSERTION_FAILED` on your `expect`.
Any other error is the scenario's own: read the `trace.md` the run names, which
has the failing line and the screen at that moment, and fix the scenario. Then
fix the bug and run it again until it passes.

## 4. Prove and report

Commit the fix first: `scenarios:prove` runs commits, not your working tree.
The scenario file itself is read from this checkout, committed or not.

```sh
vp run scenarios:prove scripts/scenarios/<name>.e2e.ts --base origin/main --upload-command "ghdrop upload"
```

- Exit `0` is a proof. `1` did not prove, `2` the app did not start, `3` the
  scenario stopped before its assertion.
- Look at both captures in `scripts/.e2e/prove/` before you claim anything.
- `--upload-command` takes any command that prints one URL per capture path.
  Without one, the images in `proof.md` are local paths that do not load on
  GitHub: upload them to the PR by hand, or say the captures are not attached.
- Paste `scripts/.e2e/prove/proof.md` into the PR's Verification section as it
  is, once its images are URLs.
- When it cannot run, say which exit code and why. Do not describe a proof you
  did not get.
