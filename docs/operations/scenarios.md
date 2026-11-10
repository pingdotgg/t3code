# Scenarios

A scenario is an [e2e](https://e2e.com/docs) test that shows one behavior in the real app: a real
server on its own T3 home, real HTTP and WebSocket, and a real browser on the web client or a
pooled iPhone simulator running the mobile app. The
dev replay agent stands in for the model, so a run is free and repeatable. Use one as the proof
for a bug fix: it fails on the base commit and passes on the fix.

Scenarios live in [`scripts/scenarios`](../../scripts/scenarios) as `*.e2e.ts`. e2e is the
runner; its docs ship in `scripts/node_modules/e2e/docs` and `e2e guide` prints them.

## Write one

```ts
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Tab moves from the add-project Git URL field to its submit button",
  WEB,
  async ({ t3, app, screen, browser }) => {
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
  },
);
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

## iOS

An iOS scenario imports from [`t3-mobile.ts`](../../scripts/scenarios/t3-mobile.ts) and passes
`IOS` where a web one passes `WEB`:

```ts
import { expect } from "e2e";

import { IOS, test } from "./t3-mobile.ts";

test(
  "The iOS app lists a seeded thread and opens its history",
  IOS,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo");
    await t3.thread({ project, title: "Earlier work", messages: ["first", "second"] });
    await t3.open();

    const thread = screen.getByText("Earlier work", { exact: false }).first();
    await expect(thread).toBeVisible({ timeout: 120_000 });
    await thread.tap();
    await expect(screen.getByText("second fixture turn complete", { exact: false })).toBeVisible();
  },
);
```

`t3.project` and `t3.thread` are the same. `t3.open()` installs the dev client for the checkout's
native fingerprint, loads it from Metro, and pairs it with the scenario's server. `device` is
e2e's [device fixture](https://e2e.com/docs/mobile#the-device-fixture) for system actions.

The run leases an iPhone 18 Pro from the Simlock pool, so it needs `SIMLOCK_AGENT_DEVICE_URL`
and `AGENT_DEVICE_DAEMON_AUTH_TOKEN`, as `mobile:e2e` does, and a gateway on Simlock 0.7.0 or
later. A web-only run leases nothing. The device reaches this machine over the tailnet on ports
13990 (server) and 8190 (Metro); set `T3_SCENARIO_SERVER_PORT` and `T3_SCENARIO_METRO_PORT` when
another run on the machine holds them. An iOS run takes two to three minutes, most of it the
device and the first bundle. `e2e run --target web` or `--target ios` runs one side.

`scenarios:prove` works the same for an iOS scenario. Each commit gets the dev client built for
its own native code.

## Other tiers

- **Android.** Add a target with `mobile({ platform: "android", device: simlock("Pixel 9") })`
  and open the dev client with the Android form of the Expo link. Not built.
- **Live provider.** Point the default model in `start-app.ts` at a real provider's cheapest
  model. Assertions on exact reply text would not hold.

## In CI

No job runs scenarios, and none should run all of them on every pull request. e2e can select the
ones a branch touches with `e2e run --changed-since origin/main` once
[test filters](https://e2e.com/docs/filters) are configured, and `@e2e-dev/github` posts the
result as a pull request comment.

## What a scenario cannot cover

- Desktop shell behavior (menus, windows, IPC), and Android.
- Provider-specific behavior. The replay agent speaks generic ACP.
- State no command can create, such as a run stopped by a usage limit.
- Timing. Replay streaming is simulated, so a scenario cannot show a performance regression.
