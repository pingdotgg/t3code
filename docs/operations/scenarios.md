# Scenarios

A scenario is an [e2e](https://e2e.com/docs) test that shows one behavior in the real app: a real
server on its own T3 home, real HTTP and WebSocket, and a real browser on the real web client. The
dev replay agent stands in for the model, so a run is free and repeatable. Use one as the proof
for a bug fix: it fails on the base commit and passes on the fix.

Scenarios live in [`scripts/scenarios`](../../scripts/scenarios) as `*.e2e.ts`. e2e is the
runner; its docs ship in `scripts/node_modules/e2e/docs` and `e2e guide` prints them.

## Write one

```ts
import { expect } from "e2e";

import { test } from "./t3.ts";

test("Tab moves from the add-project Git URL field to its submit button", async ({
  t3,
  app,
  screen,
  browser,
}) => {
  await t3.project("demo");
  await t3.open();

  await screen.getByRole("button", "Add project").tap();
  await screen.getByText("Git URL").tap();
  await screen.getByRole("combobox").fill("https://github.com/pingdotgg/t3code.git");
  const submit = screen.getByRole("button", "Continue (Enter)");
  await expect(submit).toBeEnabled();

  await browser.keyboard.press("Tab");
  await app.screenshot("after-tab");
  await expect(submit).toBeFocused();
});
```

`screen`, `browser`, `app`, and `expect` are e2e's own. [`t3.ts`](../../scripts/scenarios/t3.ts)
adds one fixture for what e2e cannot know about T3 Code:

- `t3.project(title, files)` creates a git repository and adds it as a project.
- `t3.thread({ project, title, messages })` starts a thread and plays one replayed turn per
  message before returning, so the thread has real history. `model` picks the recording.
- `t3.open(path)` opens the app, already signed in.

State is created through the app's own CLI, so it is real events and works on a base commit
whose schema differs. New threads default to the replay agent's `showcase` recording: type a
message and send it. To play something else, add a recording to the
[replay agent](development.md#replay-provider).

Take an `app.screenshot("label")` where the bug shows. The proof pairs base and head captures by
label. e2e adds a capture at the point of failure itself.

Write only `expect` assertions for the thing the bug breaks. A proof counts a failed assertion as
the bug. A control that cannot be found, or an app that does not start, counts as a scenario that
could not run.

Keep `agent.act` and `agent.assert` out of scenarios: they call a model, and no model is
configured.

## Run

```sh
vp run scenarios                                                  # all of them
cd scripts && pnpm exec e2e run scenarios/replay-turn-streams.e2e.ts --headed
```

e2e starts the dev stack through [`start-app.ts`](../../scripts/scenarios/start-app.ts) on a free
port, runs the tests, and stops it. Results land in `scripts/.e2e`: `report.json`, `summary.md`,
and per test a `trace.md`, its screenshots, and a video. The first run downloads e2e's browser.
`e2e run --help` lists the rest: `--grep`, `--watch`, `--last-failed`, `--changed-since`.

## Prove a fix

```sh
vp run scenarios:prove scripts/scenarios/add-project-tab-reaches-submit.e2e.ts \
  --base e509db3a2f^ --head e509db3a2f --upload-command "ghdrop upload"
```

[`prove-scenario.ts`](../../scripts/prove-scenario.ts) runs `e2e run` for that scenario on both
commits and compares the two reports. It prints, and writes to `scripts/.e2e/prove/proof.json`,
`failsOnBase`, `passesOnHead`, `baseSha`, `headSha`, `verdict`, each side's `steps`, `captures`,
`videos`, and `markdown`: a table with base and head captures side by side, each labelled with
its commit, ready for a pull request description. `--upload-command` names a command that takes
the capture paths and prints one URL per line. `--head` defaults to `HEAD`.

It exits 0 only when the scenario fails on base and passes on head, 1 when it ran and did not
prove the fix, and 2 when it could not run. A scenario that passes on base does not reproduce the
bug, and the verdict says so.

The scenario and e2e always come from your checkout. Only the app comes from the commit under
test: a temporary worktree beside your checkout, installed with `vp i` and removed afterwards. A
commit that is your clean `HEAD` runs in place. So a new scenario can prove a fix against a base
that predates it.

## Other tiers

Only the web client with the replay agent runs today.

- **Mobile.** e2e's `@e2e-dev/mobile` engine drives iOS and Android through agent-device, which
  this repository already uses. A mobile target in
  [`e2e.config.ts`](../../scripts/e2e.config.ts) and a `t3` fixture that pairs the device would
  run scenarios written with `screen` locators unchanged. Tests that use `browser` are web-only.
- **Live provider.** Point the default model in `start-app.ts` at a real provider's cheapest
  model. Assertions on exact reply text would not hold.

## In CI

No job runs scenarios, and none should run all of them on every pull request. e2e can select the
ones a branch touches with `e2e run --changed-since origin/main` once
[test filters](https://e2e.com/docs/filters) are configured, and `@e2e-dev/github` posts the
result as a pull request comment.

## What a scenario cannot cover

- Desktop shell behavior (menus, windows, IPC), and the mobile app until it has a target.
- Provider-specific behavior. The replay agent speaks generic ACP.
- State no command can create, such as a run stopped by a usage limit.
- Timing. Replay streaming is simulated, so a scenario cannot show a performance regression.
