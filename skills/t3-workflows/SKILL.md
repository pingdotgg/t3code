---
name: t3-workflows
description: Write, run and debug durable workflows in T3 Code: scripts that tie agent threads, plain code steps, schedules, webhooks and questions to a person into one run that survives restarts. Use when asked to automate a multi-step process with agents, to run something on a schedule or from a webhook in T3 Code, or to inspect, resume, answer or cancel a workflow run.
---

# T3 Code workflows

A workflow is a function the server runs durably. Each step's result is stored, so a restart
continues the run where it was, and a failing step pauses the run instead of losing it. A run can
sleep for days, wait for a signal, ask a person a question, and start agents in ordinary threads.

Use one when the work has more than one stage and must not be lost or repeated: triage then fix
then verify, a nightly report, a reaction to a webhook. For a single prompt on a timer, a scheduled
task is enough.

## Set up

Put a `.ts` file in the `workflows` folder of the T3 home (`~/.t3/workflows/` unless the server
was started with another home). Every file there defines workflows; there is nothing to turn on
and nothing to restart. `T3CODE_WORKFLOWS` names another folder, or one file, to read instead.

The server reads a file again when it changes and, if nothing is wrong with it, runs it from then
on. A file that does not load keeps running as it last loaded, and the server logs
`A workflow definitions file was not loaded` with the reason. A change that defines a workflow
twice, or drops a version that still has unfinished runs, is not taken up either. The Workflows
page shows the same reasons, and its Definitions view edits these files with a check on save.

Files starting with a dot are ignored, and so are folders: keep code several files share in a
subfolder and import it. Imported files are read once, so restart the server after changing one.

## The file

A file calls `T3.workflow(…)` for each workflow it defines. It imports nothing: `T3`, `Effect`,
`Schema`, `Option`, `Duration` and `Schedule` are globals.

```ts
const { workflow, agent, ask, stop, title, every, Tick } = T3;

workflow(
  "dependency-report",
  { version: 1, payload: Tick, triggers: [every("1 day")] },
  Effect.fn(function* (tick) {
    yield* title(`Dependencies ${tick.scheduledAt.slice(0, 10)}`);

    const audit = yield* agent("audit", {
      project: "project-id",
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

`T3` holds `workflow`, `step`, `sleep`, `wait`, `stop`, `title`, `agent`, `ask`, `store`, `signal`,
`signalAll`, `invoke`, `start`, `cancel`, `runs`, `issues`, `pullRequests`, and the triggers
`every`, `daily`, `webhook` with the payload schemas `Tick`, `WebhookRequest`, `Issue` and
`PullRequest`. Take what you use from it at the top of the
file, or write `T3.step(…)` in full. `Effect`, `Schema`, `Option`, `Duration` and `Schedule` are
Effect's own. An `import` of `effect` in the file would load a second copy that the engine does
not run. Node's own modules (`node:fs`, `node:crypto`) can be imported as usual.

A workflow's name and version must be defined once across all files.

## `workflow(name, options, body)`

| Option        | Meaning                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| `version`     | A number. Raise it when the body changes (see the rules below).                                                 |
| `payload`     | The Schema of what a run is started with.                                                                       |
| `returns`     | The Schema of what the body returns. Optional: without it, the run's result is whatever JSON the body returned. |
| `triggers`    | What starts a run by itself. Optional.                                                                          |
| `resumeAfter` | How long a paused run rests before it is tried again. Optional.                                                 |
| `onEnd`       | `(payload, { id, outcome, reason }) => Effect`: gives back what the run took. Optional (see below).             |

The body is `Effect.fn(function* (payload, run) { … })`; `run.id` is the run's id. Use `yield*` on
every call below.

`Schema` is Effect's, version 4. These are all a workflow file usually needs:

```ts
Schema.String;
Schema.Number;
Schema.Boolean;
Schema.Struct({ name: Schema.String, count: Schema.optional(Schema.Number) });
Schema.Array(Schema.String);
Schema.Literals(["open", "closed"]);
Schema.NullOr(Schema.String);
Schema.Record(Schema.String, Schema.Number); // two arguments, not an object
```

## Primitives

Every call takes a name first. Names are how results are stored, so each must be unique within the
workflow, across all kinds: an `ask("fix", …)` and an `agent("fix", …)` in one workflow collide and
pause the run. Name the question `approve-fix` and the agent `fix`.

| Call                                                       | Does                                                                                                                                                                                                      | Gives back                                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `step(name, { returns, retry? }, effect)`                  | Runs code once per run. `returns` is the Schema of the result.                                                                                                                                            | The result                                                                                              |
| `step.try(name, { returns, retry? }, effect)`              | As `step`, but a failure comes back instead of pausing the run.                                                                                                                                           | `{ outcome: "done", value }` or `{ outcome: "failed", reason }`                                         |
| `agent(name, { brief, project? \| thread?, returns?, … })` | One agent job in a thread a person can open. Give `project` (a T3 Code project id, or the project's folder as an absolute path) to start a thread, or `thread` from an earlier agent step to continue it. | `{ value, thread }`. `value` is data checked against `returns`, or the agent's last message without it. |
| `ask(name, { title, choices, data?, timeout? })`           | Puts a question to a person.                                                                                                                                                                              | `Option` of `{ choice, reason? }`; none after the timeout                                               |
| `wait(name, { returns, timeout?, channel? })`              | Sleeps until a signal arrives.                                                                                                                                                                            | `Option` of the signal's value; none after the timeout                                                  |
| `sleep(name, duration)`                                    | Sleeps, across restarts.                                                                                                                                                                                  | Nothing                                                                                                 |
| `title(text)`                                              | Names the run in lists.                                                                                                                                                                                   | Nothing                                                                                                 |
| `stop(reason)`                                             | Ends the run on purpose. It ends as `stopped`, which is not a failure.                                                                                                                                    | Never returns                                                                                           |
| `skip(reason)`                                             | Ends the run as not this workflow's to do: a delivery it ignores, a pull request it opened itself. It ends as `skipped`, which lists leave out unless asked.                                              | Never returns                                                                                           |

A step runs once. If it fails, the run pauses at it. Give a step that is safe to repeat
`retry: { times: 3, schedule: Schedule.exponential("2 seconds") }` to try again first. Nothing in the
body can catch a failed step, because the run has paused. When the workflow has its own answer to
a failure, use `step.try` and read `outcome`.

A call given an option it does not take fails with the options it does take: the file is not
type-checked, so a misspelt option would otherwise be ignored.

`agent` with `returns` finishes when the agent submits data that fits the schema, not when its turn
ends. Write the brief as the whole job: the agent sees only the brief and its project.
Find a project's id with the `t3_project_list` tool.
`model` is `{ instanceId, model, options? }`; leave it out for the project's default. `options`
are the model's own, as `{ id, value }` pairs: `[{ id: "reasoningEffort", value: "high" }]`.
`timeout: "2 hours"` is how long the agent has: past it the thread is stopped and the run pauses
at this step, where `resume` gives a fresh agent the job. A run paused by its agent is not resumed
by itself after `resumeAfter`: starting the job again is a person's call.

A new thread takes what `t3_thread_launch` takes:

- `workspace`: where its files are. `{ type: "root" }`, the project's checkout, is the default.
  `{ type: "worktree", baseRef: "origin/main", startFromOrigin: true }` gives it a checkout of its
  own. Use a worktree whenever agents may change files at the same time: two runs at once, or
  agents side by side in one run.
- `runtimeMode`: `full-access`, `auto`, `auto-accept-edits` or `approval-required`. The project's
  default otherwise. A step in `approval-required` waits on approvals in its thread.
- `interactionMode`: `default` or `plan`.
- `title`: the thread's title, `<workflow>: <step>` otherwise.

A continued `thread` keeps how it started, so these are refused with `thread`.

An agent that must wait for something, such as the checks of a pull request it watches or work it
left running, ends its turn and is woken later. Give that step `quiet: "45 minutes"`, and say in
the brief to end a waiting turn without submitting. The step then waits across turns for the
result, and asks for it only when the thread has done nothing for that long. Without `quiet`, a
turn that ends without the result is asked for it at once. Keep a `timeout` on such a step.

`agent.try` takes what `agent` takes and never pauses the run. It gives
`{ outcome: "done", value, thread }`, or `{ outcome: "failed", reason, thread? }` for an agent
that could not be started, died twice, ran out of time or never gave its result. Use it when the
workflow has a next move: another model, another machine, or `stop`.

```ts
Effect.fn(function* () {
  let fix = yield* agent.try("fix", { project, brief, returns: Fix, timeout: "2 hours" });
  if (fix.outcome === "failed") {
    fix = yield* agent.try("fix-again", { project, brief, returns: Fix, model: stronger });
  }
  if (fix.outcome === "failed") return yield* stop(`no fix: ${fix.reason}`);
});
```

Agents run side by side with Effect's own `Effect.all([agent("a", …), agent("b", …)], {
concurrency: 2 })`.

### Agents on other machines

`environment` runs the agent's thread in a linked environment; `project` is then a project there.
A folder there that is not a project yet is registered as one.
The run stays on this server. A continued `thread` stays in the environment it started in, so
only the first step names it.

```ts
Effect.fn(function* () {
  const fix = yield* agent("fix", {
    environment: "environment-id",
    project: "/home/user/app",
    brief: "…",
  });
});
```

`t3 environment list` prints the linked environments and their ids. Linked environments must be on
in Settings → Labs. What the agent may do there is set by the access the link was paired with.

To use a machine per run, make and link it in a `step` with your own script and return its id:
`t3 auth pairing create --json` on the new machine gives a code, and
`t3 environment link <url> --pairing-code <code> --access <access>` here links it. Delete it in
`onEnd`.

### Cleaning up

`onEnd` runs once when the run completes, stops or is cancelled; not when it pauses. It gets the
payload and the run's id, not values from the body, so name what the run takes after its id. It
also runs for a run that was cancelled before it took anything, so it must not fail on that.

```ts
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

`exec` here is your own function that runs a command and returns an Effect; it is not part of the
API. `onEnd` is tried three more times before a finished run pauses at the `onEnd` step, and a
cancelled run's is tried again up to five times; `show` has the error. A cancelled run's `onEnd`
waits for a step that was still running when the run was cancelled, so it never cleans up before
that step is done. The workflow's version stays required until that cleanup has worked.

## Other workflows

A workflow can run another. Keep the other workflow in a variable, so its payload and result are
typed, and define both in one file:

```ts
const { workflow, invoke, stop } = T3;

const review = workflow("review", { version: 1, payload: Change, returns: Verdict }, …);

workflow(
  "fix",
  { version: 1, payload: Issue },
  Effect.fn(function* (issue) {
    const ended = yield* invoke("review", review, { branch: "fix/1" });
    if (ended.outcome !== "completed") {
      return yield* stop(`review ${ended.outcome}: ${ended.reason}`);
    }
    ended.value; // a Verdict
  }),
);
```

| Call                                        | Does                                                                                                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoke(name, workflow, payload, { key? })` | In the body. Runs it as part of this run and waits. Gives `{ outcome: "completed", value }`, or `{ outcome: "stopped" \| "skipped" \| "cancelled", reason }`. A paused run is waited for.    |
| `start(workflow, payload, { key })`         | Inside `step`. Starts it and goes on without it. Gives `{ runId }`. The same `key` is the same run.                                                                                          |
| `runs({ workflow?, status?, keyPrefix? })`  | Inside `step`. `workflow` is a definition or its name. Finds runs, newest first: `{ id, workflow, key, title, status, detail, startedAt, endedAt }`. `key` is what the run was started with. |
| `cancel(runId, reason)`                     | Inside `step`. Cancels another run as a person would: its agents stop, its questions go, its `onEnd` runs. A run that has ended is left alone.                                               |

The invoked run is a run of its own in `t3 workflow list`, and is resumed by itself when it
pauses. Cancelling the run that invoked it cancels it too; a run started with `start` is on its
own. To fan out, `start` one run per item from a step, each with a key made from the item.

Start each run with a key that names its subject and ends in a separator, `issue/412/` for
example. A later step then finds it with `runs({ workflow: fix, keyPrefix: "issue/412/" })`, and
cancels it when the subject is gone. Without the separator, `issue/412` would also find `issue/4120`.
A run cannot cancel itself; it ends itself with `stop`.

## The store

`store` holds state that outlives a run and is shared by every workflow on the server: a cursor,
a switch, a counter, a queue. Its values change over time, so read and write it inside `step` or
`onEnd`, never in the body between steps.

```ts
const seen = store.entry("issues/seen", Schema.String); // one key and the Schema of its value

Effect.fn(function* () {
  const fresh = yield* step(
    "fetch",
    { returns: Schema.Array(Issue) },
    Effect.gen(function* () {
      const since = yield* seen.get; // Option
      const issues = yield* fetchIssuesAfter(Option.getOrUndefined(since));
      if (issues[0]) yield* seen.set(issues[0].createdAt);
      return issues;
    }),
  );
});
```

| Call                                       | Does                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `store.entry(key, Schema)`                 | One key. `.get` gives an `Option`; `.set(value)`; `.delete`.                                                       |
| `entry.update((current) => next)`          | Reads and writes as one action; `current` is an `Option`. Returning `undefined` deletes.                           |
| `store.entries(prefix, Schema)`            | Every `{ key, value }` whose key starts with `prefix`, in key order.                                               |
| `store.transaction(effect)`                | Everything the effect reads and writes happens together, or not at all if it fails.                                |
| `signal(address, value, { id?, ttl? })`    | Wakes a `wait`: `{ runId, wait }` or `{ workflow, channel }`. Inside `step` or `onEnd` only.                       |
| `signalAll({ channel, workflow? }, value)` | Wakes every run that waits on `channel`, in one workflow or in all. Gives how many. Inside `step` or `onEnd` only. |

`signal` wakes one wait and is kept for a wait that opens later. `signalAll` wakes all who wait
now and keeps nothing. To hold runs while something is true, each run reads the switch in a
`step` and, while it is on, calls `wait(...)` with `{ channel: "main-green", timeout: "10 minutes",
returns: Schema.Null }` and reads the switch again. Number the names in that loop, `switch/1` and
`released/1`, then `switch/2` and `released/2`: a name is used once in a run, and a step named
twice would give back what it read the first time. Whoever turns the switch off calls
`signalAll({ channel: "main-green" }, null)`, and the timeout covers a run that began to wait just
after.

Use `update` or `transaction` whenever a write depends on a read: several runs share the store.
A step that fails after writing is run again, so write what is safe to write twice, or put the
writes in one `transaction` with the part that can fail. A person sees and changes the store with
`t3 workflow store list [prefix]`, `store set <key> '<json>'` and `store delete <key>`, which is
how a switch a workflow reads gets flipped.

## Issues and pull requests

`issues` and `pullRequests` read and write the project's tracker and git host with the project's
own credentials, the ones the Issues and Pull requests pages use. Call them inside `step`.
`project` is a project id or its folder, as for `agent`.

```ts
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

| Call                                                        | Gives                                                                             |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `issues.list({ project, state?, labels?, query?, limit? })` | `Issue` rows. `state` defaults to `open`.                                         |
| `issues.read(issue)`                                        | The body, comments and the `states` it can take.                                  |
| `issues.comment(issue, body)`                               | Nothing.                                                                          |
| `issues.setState(issue, name)`                              | Nothing. `name` is one of the issue's `states`.                                   |
| `issues.create({ project, title, body?, labels? })`         | `{ key, displayKey, url }`.                                                       |
| `pullRequests.list({ project, state?, query?, limit? })`    | `PullRequest` rows.                                                               |
| `pullRequests.read(pullRequest)`                            | State, checks, reviews and mergeability.                                          |
| `pullRequests.comment(pullRequest, body)`                   | Nothing.                                                                          |
| `pullRequests.act(pullRequest, action, { mergeMethod? })`   | Nothing. `merge`, `close`, `ready`, `update-branch` and the host's other actions. |

Give an agent step `issue` and its thread is linked to that issue: the thread shows the issue and
the issue's page lists the thread. That holds for a thread on this server, not for one in a linked
`environment`.

An issue or pull request is named by what a trigger or `list` gave, or by `{ project, url }`, which
is how to name one an agent returned the address of. A comment is posted again if its step is run
again, so keep one comment to one step.

`pullRequests.wait(name, pullRequest, { until, timeout? })` is for the body, not a step. The run
rests until the pull request gets there: `until: "checks"` until none of its checks is still
running, `"merged"` or `"closed"` until it is no longer open. Merging or closing ends any of them.
It gives `{ state, checks, mergeability, url }`, with `checks` one of `passing`, `failing`,
`pending` or `none`, or nothing after `timeout`. Read `state` first: a wait for checks also ends
when someone closes the pull request.

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

A workflow with `triggers` starts by itself, and its `payload` is what the trigger gives.

- `every("1 hour")`: payload `Tick` (`{ scheduledAt }`). At least a minute apart. After downtime it
  starts one run, not one per missed time.
- `daily("09:00", { weekdays: [1, 2, 3, 4, 5] })`: payload `Tick`. Server's local time, 0 is
  Sunday. A time missed by more than ten minutes is skipped.
- `webhook("name", { key? })`: payload `WebhookRequest` (`{ method, headers, query, body }`,
  header names lower case, `query` and `body` as text). Pass `WebhookRequest` itself as `payload`;
  do not write the shape out again. `t3 workflow hooks` prints the URL path; it contains
  the hook's secret. `key` returns the sender's delivery id, so a retry is the same run:
  `key: (request) => request.headers["x-github-delivery"]`.

- `issues.opened({ project, labels?, query? })`: payload `Issue`. One run for each issue opened in
  the project's tracker (GitHub, GitLab, Linear and the others T3 Code reads) after the workflow
  was first loaded. `labels` must all be on the issue. No webhook to set up: the tracker is asked
  about once a minute.
- `pullRequests.opened({ project, query? })`: payload `PullRequest`. The same for pull requests.

A triggered workflow filters in its body. Parse `request.body`, and `skip("not a push to main")`
for what it does not care about, so those runs stay out of the lists. To check a signature, do it in a `step`.

A workflow without triggers is started by hand or by another program:
`t3 workflow start <name> --input '<json>' --key <key>`. The same key is the same run, whichever
version starts it.

## Rules that are easy to break

1. **The body is replayed.** After a restart or a wait, the function runs again from the top and
   each call returns what it stored. So everything that touches the world goes inside `step` or
   `agent`: reading a file, calling an API, the clock, randomness. Code between calls must compute
   the same thing every time from the payload and earlier results.
2. **Do not reorder or rename calls in a workflow that has unfinished runs.** Register the changed
   body under a higher `version` and keep the old one in the file until its runs have ended. New
   runs use the highest version.
3. **Results must fit their Schema**, and so must the payload. They are stored as JSON.
4. **A step may run more than once**, after a crash mid-step or a resume. Make side effects safe
   to repeat, for example by passing an id derived from the payload to the system being called.
5. **Loops need distinct names**: `step(\`check-${i}\`, …)`.

## Run and debug

```sh
t3 workflow list [--status paused]        # runs
t3 workflow show <run>                    # one run and its steps, with the reason for a pause
t3 workflow resume <run>                  # run a paused run's failed step again
t3 workflow cancel <run>
t3 workflow questions                     # what runs are asking a person
t3 workflow signal '{"choice":"upgrade"}' --run <run> --wait approve-upgrade   # answer a question
t3 workflow signal '<json>' --workflow <name> --channel <channel>      # wake a wait by channel
t3 workflow hooks                         # webhook URL paths
t3 workflow store list [prefix]           # what workflows keep between runs
```

Run states: `running`, `waiting` (on an agent, a signal, a question or a sleep), `paused` (a step failed),
`completed`, `stopped`, `cancelled`.

A paused run shows the failing step and its error in `show`. Fix the cause, then `resume`; only
that step runs again. A paused run is also resumed by itself after 5, 20 and 80 minutes;
`resumeAfter` in the workflow's options changes that. A run paused by an agent that gave up waits
for a person. A run whose version is no longer in the file
is marked `retired` in `show --json` and cannot continue until the version is back.

An agent step's thread is an ordinary thread. Open it to see what the agent did, and talk to it if
it is stuck: the step completes when it submits its result.
