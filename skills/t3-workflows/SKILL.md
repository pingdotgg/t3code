---
name: t3-workflows
description: Author, edit, run, and debug durable T3 Code workflows (`~/.t3/workflows/*.ts`). Use when asked to build or change a multi-step T3 Code automation tying together agent threads, code steps, schedules, webhooks, issue/PR trackers, or human approvals, or to inspect, resume, signal, or cancel workflow runs.
---

# T3 Code workflows

A workflow is a TypeScript function the T3 Code server runs durably on Effect v4 (`effect/workflow`). Every step's result is stored, so restarts replay to where the run left off and a failing step pauses the run instead of losing it. Runs can sleep for days, wait on signals or pull requests, ask a person a question, and launch agents in ordinary threads.

Use a workflow for multi-stage work that must not be lost or repeated (triage → fix → verify, nightly reports, webhook reactions). For a single prompt on a timer, use a scheduled task instead.

## Quick start

Workflows are a Labs feature, off by default. If `t3 workflow` says workflows are off, ask the user to turn them on in Settings → Labs → Workflows; do not edit their settings yourself.

Put a `.ts` file in `~/.t3/workflows/` (the `workflows` folder of T3 home, or the path in `T3CODE_WORKFLOWS`). Once workflows are on, the server watches the folder and reloads files automatically—nothing to restart. A file name with a space or other unusual character (`fix issue.ts`) is skipped with a warning in the server log: use letters, digits, `-`, `_` and `.`. Files run with Node's type stripping, so only erasable TypeScript works: no `enum`, `namespace` or parameter properties.

Workflow files import nothing from T3 or Effect. `T3`, `Effect`, `Schema`, `Option`, `Duration`, and `Schedule` are injected as globals. Never `import` from `effect` (that loads a second runtime copy the engine cannot run). Node built-ins (`node:fs`, `node:crypto`) can be imported normally.

```ts
const { workflow, agent, ask, stop, title, every, Tick } = T3;

workflow(
  "dependency-report",
  { version: 1, payload: Tick, triggers: [every("1 day")] },
  Effect.fn(function* (tick) {
    yield* title(`Dependencies ${tick.scheduledAt.slice(0, 10)}`);

    const audit = yield* agent("audit", {
      project: "/home/me/app", // the project's folder, or its id
      brief: "List this repository's outdated dependencies. Do not change any file.",
      returns: Schema.Struct({
        outdated: Schema.Array(Schema.Struct({ name: Schema.String, latest: Schema.String })),
      }),
    });
    if (audit.value.outdated.length === 0) return yield* stop("nothing is outdated");

    const answer = yield* ask("approve-upgrade", {
      title: `Upgrade ${audit.value.outdated.length} dependencies?`,
      choices: ["upgrade", "skip"],
      data: audit.value,
      timeout: "2 days",
    });
    if (Option.isNone(answer) || answer.value.choice === "skip") {
      return yield* stop("not approved");
    }

    yield* agent("upgrade", {
      thread: audit.thread,
      brief: "Upgrade the dependencies you listed, run the tests, and say what changed.",
    });
  }),
);
```

### What `T3` holds

Only `T3`, `Effect`, `Schema`, `Option`, `Duration` and `Schedule` are globals. Everything below is a
property of `T3`: take what you use at the top of the file, as the quick start does
(`const { workflow, step, daily } = T3;`), or write `T3.step(…)` in full. A bare `daily(…)` or
`step(…)` without that line is a `ReferenceError`.

- **Definitions & body**: `workflow`, `step`, `agent`, `ask`, `wait`, `sleep`, `title`, `stop`, `skip`, `invoke`
- **Inside `step` / `onEnd` only**: `store`, `signal`, `signalAll`, `start`, `runs`, `cancel`
- **Trackers & hosts**: `issues`, `pullRequests` (triggers, step calls, and `pullRequests.wait` in the body)
- **Triggers**: `every`, `daily`, `webhook`
- **Schemas**: `Tick`, `WebhookRequest`, `Issue`, `IssueDetail`, `PullRequest`, `PullRequestStanding`

### Effect v4 `Schema` cheatsheet

```ts
Schema.String;
Schema.Number;
Schema.Boolean;
Schema.Void;
Schema.Null;
Schema.Struct({ name: Schema.String, count: Schema.optional(Schema.Number) });
Schema.Array(Schema.String);
Schema.Literals(["open", "closed"]);
Schema.NullOr(Schema.String);
Schema.Record(Schema.String, Schema.Number); // two arguments, not an object
```

## Defining a workflow

`workflow(name, options, body)` registers a workflow and returns a handle you can pass to `invoke`, `start`, `runs`, or `signal`. Each `(name, version)` pair must be unique across all files.

| Option        | Required | Meaning                                                                                                                                                                                     |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`     | Yes      | Integer version. Raise it whenever the body changes (see rules below).                                                                                                                      |
| `payload`     | Yes      | `Schema` of the run's input.                                                                                                                                                                |
| `returns`     | No       | `Schema` of the body's return value. If omitted, any JSON value (or `undefined`) is accepted.                                                                                               |
| `triggers`    | No       | Array of triggers that start runs automatically.                                                                                                                                            |
| `resumeAfter` | No       | Durations to wait before auto-resuming a paused run. Defaults to `["5 minutes", "20 minutes", "80 minutes"]`. The server checks about every 15 seconds, so shorter waits act as 15 seconds. |
| `onEnd`       | No       | `(payload, { id, outcome, reason }) => Effect`: cleanup hook run once when the run ends.                                                                                                    |

The body is `Effect.fn(function* (payload, run) { … })`, where `run.id` is the run's id. Use `yield*` on every primitive.

### Cleanup with `onEnd`

`onEnd` runs once when a run completes, stops, is skipped, or is cancelled—not when it pauses. It runs with step services (`store`, `signal`, `issues`, etc.), receives `(payload, { id, outcome, reason })`, and cannot see local variables from the body. Name external resources after `run.id`, and make `onEnd` safe if the run was cancelled before acquiring anything.

```ts
const { workflow, step, agent, Issue } = T3;

workflow(
  "fix",
  {
    version: 1,
    payload: Issue,
    onEnd: (issue, end) => exec("machines.sh", ["delete", `fix-${end.id}`]),
  },
  Effect.fn(function* (issue, run) {
    const environment = yield* step(
      "machine",
      { returns: Schema.String },
      exec("machines.sh", ["create-and-link", `fix-${run.id}`]),
    );
    yield* agent("fix", { environment, project: "/home/user/app", brief: issue.title });
  }),
);
```

(`exec` above is your own Effect helper, not part of `T3`.) On normal end, `onEnd` retries 3 times before pausing at the `onEnd` step; on cancel, it waits for any in-flight step to finish, then tries up to 5 times, 5 minutes, 20 minutes, 80 minutes and 5 hours apart. The workflow version stays required until one try succeeds; after the last failed try the `onEnd` step stays `failed` on the run and nothing retries it, so make cleanup something a person can redo by hand.

## Body primitives

Call these directly in the workflow body with `yield*`. Every named primitive stores its result under `name`, which must be unique across all primitives in the run (an `ask("fix", …)` and `agent("fix", …)` collide).

| Call                                                           | Behavior                                                                                                                                   | Returns                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `step(name, { returns, retry? }, effect)`                      | Runs code once per run and journals the result. Failure pauses the run.                                                                    | `A`                                                                                               |
| `step.try(name, { returns, retry? }, effect)`                  | Same as `step`, but returns failure as data instead of pausing.                                                                            | `{ outcome: "done", value }` or `{ outcome: "failed", reason }`                                   |
| `agent(name, { brief, project? \| thread?, returns?, … })`     | Runs an agent in a thread. Failure pauses the run for a person.                                                                            | `{ value, thread }` (`value` matches `returns`, or last reply string)                             |
| `agent.try(name, { brief, project? \| thread?, returns?, … })` | Same as `agent`, but returns failure as data instead of pausing.                                                                           | `{ outcome: "done", value, thread }` or `{ outcome: "failed", reason, thread? }`                  |
| `ask(name, { title, choices, data?, timeout? })`               | Puts a multiple-choice question to a person.                                                                                               | `Option<{ choice, reason? }>` (`None` on timeout)                                                 |
| `wait(name, { returns, timeout?, channel? })`                  | Sleeps until signalled by `{ runId, wait }` or `{ workflow, channel }`.                                                                    | `Option<A>` (`None` on timeout)                                                                   |
| `pullRequests.wait(name, pr, { until, timeout? })`             | Sleeps until PR checks settle, or the PR merges or closes.                                                                                 | `Option<PullRequestStanding>` (`None` on timeout)                                                 |
| `sleep(name, duration)`                                        | Durable sleep across restarts (e.g. `"1 hour"`, `"2 days"`).                                                                               | `void`                                                                                            |
| `invoke(name, workflow, payload, { key? })`                    | Runs another workflow as a child run and waits for it to end.                                                                              | `{ outcome: "completed", value }` or `{ outcome: "stopped" \| "skipped" \| "cancelled", reason }` |
| `title(text)`                                                  | Sets the run's display title in lists (cut to 200 characters). Takes no step name.                                                         | `void`                                                                                            |
| `stop(reason)`                                                 | Ends the run on purpose as `stopped` (not a failure). Body only: inside a `step` it fails the step and pauses the run, and so does `skip`. | `never`                                                                                           |
| `skip(reason)`                                                 | Ends the run as `skipped`, which run lists leave out unless asked (`runs()` includes them).                                                | `never`                                                                                           |

- **Retries and failures:** A `step` runs once by default. For idempotent work, pass `retry: { times: 3, schedule: Schedule.exponential("2 seconds") }`. Nothing in the body can catch a failed `step` or `agent` because the engine pauses the run—use `step.try` or `agent.try` whenever the workflow should branch on failure.
- **Timeouts are checked about every 15 seconds:** a `wait` or `ask` timeout can end up to 15 seconds late, and a signal that arrives before the check still wins.
- **`Option` results:** `wait`, `ask` and `pullRequests.wait` always give an `Option`, with or without a `timeout`. Check `Option.isNone(result)` first, then read `result.value`. Never put the `Option` itself into a string or a return value.
- **Concurrency:** Run steps or agents in parallel with `Effect.all([agent("a", …), agent("b", …)], { concurrency: 2 })`.
- **Strict options:** Every call refuses an option it does not take, naming the ones it does, since workflow files are not type-checked. So does `every` under a minute and a `daily` time it cannot read.

## Agents (`agent` and `agent.try`)

| Option            | Applies to | Meaning                                                                                                                                             |
| ----------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `brief`           | All        | Full task instructions. The agent sees only this brief and its project.                                                                             |
| `project`         | New thread | Project id (from `t3_project_list`) or absolute folder path.                                                                                        |
| `thread`          | Continue   | `thread` returned by an earlier `agent` step. Continues it as it started, so the New thread options are refused alongside it.                       |
| `returns`         | All        | Optional `Schema`. Completes only when the agent submits valid data (up to 2 correction prompts).                                                   |
| `model`           | New thread | `{ instanceId, model, options? }`; `options` is `[{ id, value }]` (e.g. `[{ id: "reasoningEffort", value: "high" }]`). Defaults to project default. |
| `workspace`       | New thread | `{ type: "root" }` (default) or `{ type: "worktree", baseRef: "origin/main", startFromOrigin: true }`.                                              |
| `runtimeMode`     | New thread | `"full-access" \| "auto" \| "auto-accept-edits" \| "approval-required"` (waits on thread approvals). Project default if omitted.                    |
| `interactionMode` | New thread | `"default" \| "plan"`.                                                                                                                              |
| `title`           | New thread | Thread title. Defaults to `<workflow>: <step>`.                                                                                                     |
| `environment`     | New thread | Linked environment id (`t3 environment list`). Folder paths not yet registered there are registered automatically.                                  |
| `issue`           | Local only | `Issue` or `{ project, url }`. Links the thread to that issue (not applied in linked environments).                                                 |
| `timeout`         | All        | Time limit for each attempt (e.g. `"2 hours"`); an automatic retry or a resume starts a new one. Past it, the turn is stopped and the step fails.   |
| `quiet`           | All        | Idle grace period (e.g. `"45 minutes"`) for agents that wait across turns before submitting `returns`.                                              |

- **Worktrees:** Use a `worktree` workspace whenever two agents can edit the same repo at once (concurrent runs or parallel `agent` calls).
- **Waiting across turns (`quiet`):** If an agent watches PR checks or background work and ends its turn while waiting to be woken, set `quiet: "45 minutes"` and tell it in `brief` to end waiting turns without submitting. The step prompts for the result only after the thread has been idle for `quiet`. Without `quiet`, it prompts as soon as a turn ends without output. Always set a `timeout` alongside `quiet`.
- **Retries and pauses:** If a turn dies (crashes or is cut off), `agent` automatically tries once more (on a fresh thread, or the same thread if continuing `thread`). An agent that finishes its turn without valid `returns` is asked to correct it twice in the same thread, and then gives up without starting the job again. A timeout or manual stop does not auto-retry. A run paused by an agent that ran and gave up or timed out waits for a person—`resumeAfter` does not auto-resume it (`t3 workflow resume` starts a fresh attempt). An agent that could not be started at all (no project at that folder, linked environment unreachable) pauses like a failed `step` and resumes on its own; `agent.try` returns that failure as data instead.
- **Fallback with `agent.try`:**

```ts
Effect.fn(function* () {
  let fix = yield* agent.try("fix", { project, brief, returns: Fix, timeout: "2 hours" });
  if (fix.outcome === "failed") {
    fix = yield* agent.try("fix-again", { project, brief, returns: Fix, model: stronger });
  }
  if (fix.outcome === "failed") return yield* stop(`no fix: ${fix.reason}`);
});
```

- **Linked environments:** Enable Settings → Labs → Linked environments. The run stays on this server; only the thread runs remotely, bounded by the link's paired access. For a machine per run, create and link it in a `step` (`t3 auth pairing create --json` on the remote, `t3 environment link <url> --pairing-code <code> --access <access>` here), return its id, and delete it in `onEnd`.

## Other workflows

Define caller and callee in the same file and keep the callee in a variable so its payload and return type flow through:

```ts
const { workflow, invoke, stop } = T3;

const review = workflow("review", { version: 1, payload: Change, returns: Verdict }, reviewBody);

workflow(
  "fix",
  { version: 1, payload: Issue },
  Effect.fn(function* (issue) {
    const ended = yield* invoke("review", review, { branch: `fix/${issue.key}` });
    if (ended.outcome !== "completed") {
      return yield* stop(`review ${ended.outcome}: ${ended.reason}`);
    }
    return ended.value; // Verdict
  }),
);
```

| Call                                        | Where            | Behavior                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoke(name, workflow, payload, { key? })` | Body             | Starts a child run and waits for it (including while it is paused). Listed and resumed independently; cancelling the parent cancels the child. Pass the definition `workflow(…)` returned, not its name. `key` names the child run; one already started under that key by something else is refused. |
| `start(workflow, payload, { key })`         | `step` / `onEnd` | Fire-and-forget. Returns `{ runId }`. Same `key` returns the same run. Use for fan-out.                                                                                                                                                                                                              |
| `runs({ workflow?, status?, keyPrefix? })`  | `step` / `onEnd` | Lists up to 500 matching runs (skipped runs included), newest first: `{ id, workflow, key, title, status, detail, startedAt, endedAt }`. `workflow` is a definition or its name.                                                                                                                     |
| `cancel(runId, reason)`                     | `step` / `onEnd` | Cancels another run (stops agents, withdraws questions, cancels invoked children, runs `onEnd`). Cannot cancel self—use `stop`.                                                                                                                                                                      |

End subject keys with a separator (e.g. `issue/412/`), so `runs({ workflow: fix, keyPrefix: "issue/412/" })` does not match `issue/4120`.

## Store and signals

`store` holds durable key-value state shared across all workflows on the server (cursors, switches, counters, queues). Call `store`, `signal`, and `signalAll` **only inside `step` or `onEnd`**—never directly in the body.

| Call                                       | Behavior                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store.entry(key, Schema)`                 | Handle for one key: `.get` (`Option<A>`), `.set(value)`, `.delete`.                                                                                                                                                                                                                                                                                               |
| `entry.update((current) => next)`          | Atomic read-modify-write; `current` is `Option<A>`. Return `undefined` to delete. Returns `Option<A>`.                                                                                                                                                                                                                                                            |
| `store.entries(prefix, Schema)`            | Every `{ key, value }` starting with `prefix`, in key order. Fails if any matching row does not fit `Schema`.                                                                                                                                                                                                                                                     |
| `store.transaction(effect)`                | Runs all store reads and writes in `effect` atomically (all or nothing).                                                                                                                                                                                                                                                                                          |
| `signal(address, value, { id?, ttl? })`    | Wakes one `wait` at `{ runId, wait }` or `{ workflow, channel }`. Buffered until a wait opens or `ttl` (default 7 days) expires. Returns `"delivered" \| "buffered"`. `"buffered"` checks neither the address nor the shape: a wrong workflow or wait name, or a run that has ended, also buffers. A value that does not fit an open wait fails the sending step. |
| `signalAll({ channel, workflow? }, value)` | Wakes every run currently waiting on `channel` (one workflow or all). Returns count woken. Buffers nothing.                                                                                                                                                                                                                                                       |

```ts
const { step, store, Issue } = T3;
const seen = store.entry("issues/seen", Schema.String);

Effect.fn(function* () {
  const fresh = yield* step(
    "fetch",
    { returns: Schema.Array(Issue) },
    Effect.gen(function* () {
      const since = yield* seen.get;
      const batch = yield* fetchIssuesAfter(Option.getOrUndefined(since));
      if (batch[0]) yield* seen.set(batch[0].createdAt);
      return batch;
    }),
  );
});
```

- **Shared gate pattern (`signalAll`):** Because `signalAll` keeps nothing for late arrivals, check the switch in a `step`, then while it is on call `wait` with `{ channel: "main-green", timeout: "10 minutes", returns: Schema.Null }` and re-check in a loop. Number step names per iteration (`switch/1`, `released/1`, `switch/2`, `released/2`). Whoever clears the switch calls `signalAll({ channel: "main-green" }, null)`.
- **Transactions:** Use `entry.update` or `store.transaction` whenever a write depends on a read, or when a step might fail after writing.
- **CLI access:** Inspect or flip keys with `t3 workflow store list [prefix]`, `store set <key> '<json>'`, and `store delete <key>`.

## Issues and pull requests

Reads and writes the project's configured tracker (GitHub, GitLab, Linear, etc.) and git host using the project's credentials. Pass an issue/PR object from a trigger or `list`, or `{ project, url }` (useful when an agent returns a URL).

| Call                                                                          | Where            | Returns                                                                |
| ----------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------- |
| `issues.list({ project, state?, labels?, query?, assignee?, sort?, limit? })` | `step` / `onEnd` | `Issue[]` (`state` defaults to `"open"`)                               |
| `issues.read(issue)`                                                          | `step` / `onEnd` | `IssueDetail` (body, comments, valid `states`)                         |
| `issues.comment(issue, body)`                                                 | `step` / `onEnd` | `void`                                                                 |
| `issues.setState(issue, name)`                                                | `step` / `onEnd` | `void` (`name` from `issues.read(issue).states`)                       |
| `issues.create({ project, title, body?, labels?, assignees? })`               | `step` / `onEnd` | `{ key, displayKey, url }`                                             |
| `pullRequests.list({ project, state?, query?, limit? })`                      | `step` / `onEnd` | `PullRequest[]` (`state` defaults to `"open"`)                         |
| `pullRequests.read(pr)`                                                       | `step` / `onEnd` | State, checks, reviews, mergeability                                   |
| `pullRequests.comment(pr, body)`                                              | `step` / `onEnd` | `void`                                                                 |
| `pullRequests.act(pr, action, { mergeMethod? })`                              | `step` / `onEnd` | `void` (`merge`, `close`, `ready`, `update-branch`, etc.)              |
| `pullRequests.wait(name, pr, { until, timeout? })`                            | **Body**         | `Option<PullRequestStanding>` (`{ state, checks, mergeability, url }`) |

Keep one comment or mutation per `step` so a retry does not post twice.

```ts
const { workflow, title, agent, step, issues, Issue } = T3;

workflow(
  "triage",
  { version: 1, payload: Issue, triggers: [issues.opened({ project: "/home/me/app" })] },
  Effect.fn(function* (issue) {
    yield* title(`${issue.displayKey} ${issue.title}`);
    const found = yield* agent("reproduce", {
      project: "/home/me/app",
      issue,
      brief: `Reproduce this on main. Change nothing.\n\n${issue.url}`,
      returns: Schema.Struct({ reproduced: Schema.Boolean, summary: Schema.String }),
    });
    yield* step("report", { returns: Schema.Void }, issues.comment(issue, found.value.summary));
  }),
);
```

`pullRequests.wait` polls about once a minute. `until` is `"checks"` (no checks still pending), `"merged"`, or `"closed"`. Merging or closing ends any wait, so always check `state` before `checks` (`"passing" | "failing" | "pending" | "none"`):

```ts
Effect.fn(function* () {
  const at = yield* pullRequests.wait(
    "checks",
    { project, url },
    { until: "checks", timeout: "2 hours" },
  );
  if (Option.isNone(at) || at.value.state !== "open" || at.value.checks !== "passing") {
    return yield* stop("not ready to merge");
  }
  yield* step("merge", { returns: Schema.Void }, pullRequests.act({ project, url }, "merge"));
});
```

## Triggers

A workflow's `payload` schema must match what its `triggers` emit.

| Trigger                                          | Payload          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `every("1 hour")`                                | `Tick`           | `{ scheduledAt }`. Minimum 1 minute. The first run comes one interval after the file loads, not at load. Downtime collapses into one run, not one per missed interval.                                                                                                                                                                                                                                                                                                                     |
| `daily("09:00", { weekdays?: [1, 2, 3, 4, 5] })` | `Tick`           | Server local time; `0` is Sunday. Missed by more than 10 minutes is skipped.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `webhook("name", { key? })`                      | `WebhookRequest` | `{ method, headers, query, body }` (lowercase header names, text `query`/`body`). Set `payload: WebhookRequest`, taken from `T3`; never write its shape out yourself. `t3 workflow hooks` prints URL paths (includes secret). A retry that repeats a delivery header (`X-GitHub-Delivery`, `Idempotency-Key`, `webhook-id`, and the Gitea, GitLab and Linear ones) starts no second run; for other senders, `key: (r) => …` names the run from the request. Bodies over 1 MiB are refused. |
| `issues.opened({ project, labels?, query? })`    | `Issue`          | Polls ~once a minute. Only issues opened after the workflow first loaded. Issue must carry all `labels`.                                                                                                                                                                                                                                                                                                                                                                                   |
| `pullRequests.opened({ project, query? })`       | `PullRequest`    | Polls ~once a minute. Only pull requests opened after the workflow first loaded.                                                                                                                                                                                                                                                                                                                                                                                                           |

Filter unwanted deliveries in the body with `skip("not a push to main")` so they stay out of run lists. Verify webhook signatures inside a `step`.

Start any workflow manually with `t3 workflow start <name> --input '<json>' --key <key>`. A `key` identifies one run of that workflow across all versions.

## Rules you must not break

1. **The body is replayed from the top.** After every wait or restart, the body runs again and completed primitives return their stored values. Put all side effects, I/O, clock reads, randomness, and `store`/API reads inside `step` or `agent`. Code between calls must be deterministic given `payload` and earlier results.
2. **Names are journal keys.** Every named primitive (`step`, `agent`, `ask`, `wait`, `sleep`, `invoke`, `pullRequests.wait`) must have a unique name within the run, across all kinds. Loops need distinct names (``step(`check-${i}`, …)``). Never name a body step `"onEnd"` (reserved for cleanup). `invoke("x", …)` also takes `x/start`, and `title(…)` takes `title/0`, `title/1`, ….
3. **Bump `version` when changing a live workflow.** Do not reorder, rename, or change the stored schema of steps in a version that still has unfinished runs. Register the updated body under a higher `version` and keep the old version in the file until its runs finish. Runs started by the CLI, a trigger or a webhook use the highest version; `start` and `invoke` run the version of the definition you pass them, so point callers at the new definition when you bump. Keys still deduplicate across versions.
4. **Never import `effect`, and take every `T3` name you use.** The globals are `T3`, `Effect`, `Schema`, `Option`, `Duration` and `Schedule`; `step`, `daily`, `WebhookRequest` and the rest come from `const { … } = T3;` at the top of the file, and one left out of that line is a `ReferenceError`. Shared helpers go in a subfolder (dotfiles and folders are ignored by the loader), and changing an imported helper requires a server restart.
5. **Payloads and step results must fit their `Schema`.** Everything journaled is serialized as JSON; a value that fails encoding fails the step.
6. **Steps can run more than once.** A crash mid-step, a retry, or a manual resume re-runs the step. Make external side effects idempotent (derive idempotency keys from `payload` or `run.id`, keep one comment/post per step, wrap dependent store writes in `store.transaction`).

## Files, reloading, and CLI

If an edited file fails to load, its last good version keeps running and the server logs `A workflow definitions file was not loaded` with the reason. A change that defines the same `(name, version)` twice or removes a version with unfinished runs is rejected. The Workflows page shows these errors, and its Definitions view validates files on save.

```sh
t3 workflow start <name> --input '<json>' --key <key>
t3 workflow list [--status paused]
t3 workflow show <run> [--json]
t3 workflow resume <run>
t3 workflow cancel <run> [--reason '<why>']
t3 workflow questions
t3 workflow signal '{"choice":"upgrade"}' --run <run> --wait approve-upgrade
t3 workflow signal '<json>' --workflow <name> --channel <channel>
t3 workflow hooks
t3 workflow store list [prefix]
t3 workflow store set <key> '<json>'
t3 workflow store delete <key>
```

- **Run states:** `running`, `waiting` (agent, signal, question, PR wait, or sleep), `paused` (step failed), `completed`, `stopped`, `skipped`, `cancelled`.
- **Resuming:** Check the failing step and error with `show`, fix the cause, then `resume` (only the failed step re-runs). A paused run also resumes by itself on `resumeAfter` (default 5, 20, 80 minutes), unless it paused because its agent gave up.
- **Retired runs:** A run whose version was removed shows `"retired": true` in `show --json` and cannot continue until that version is restored.
- **Stuck agents:** An agent step's thread is an ordinary thread—open it to inspect or steer the agent. The step finishes as soon as the agent submits its result.
