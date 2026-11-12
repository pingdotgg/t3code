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

1. Write one definitions file (below). It imports nothing.
2. Start the server with `T3CODE_WORKFLOWS=/absolute/path/to/workflows.ts`. Without it, workflows
   are off and every `t3 workflow` command says so.
3. Restart the server after editing the file. Definitions are read once, at start.

If the file does not load, the server logs `Workflows are off: their definitions did not load`
and keeps running without them.

## The file

The default export is a function. The server calls it with the API and registers what it returns.

```ts
export default ({
  workflow,
  step,
  agent,
  ask,
  stop,
  title,
  every,
  Tick,
  Effect,
  Schema,
  Option,
}) => [
  workflow(
    "dependency-report",
    { version: 1, payload: Tick, triggers: [every("1 day")] },
    Effect.fn(function* (tick) {
      yield* title("name", `Dependencies ${tick.scheduledAt.slice(0, 10)}`);

      const audit = yield* agent("audit", {
        project: "project-id",
        brief: "List this repository's outdated dependencies. Do not change any file.",
        output: Schema.Struct({
          outdated: Schema.Array(Schema.Struct({ name: Schema.String, latest: Schema.String })),
        }),
      });
      if (audit.value.outdated.length === 0) return yield* stop("nothing is outdated");

      const answer = yield* ask("upgrade", {
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
  ),
];
```

The API object holds `workflow`, `step`, `sleep`, `wait`, `stop`, `title`, `agent`, `ask`, the
triggers `every`, `daily`, `webhook` with their payload schemas `Tick` and `WebhookRequest`, and
Effect's `Effect`, `Schema`, `Option`, `Duration`, `Schedule`. Take everything from it, and list each name you use in the function's parameter: a name that is
not listed, `Option` for example, is not defined. An
`import` of `effect` in the file would load a second copy that the engine does not run. Node's own
modules (`node:fs`, `node:crypto`) can be imported as usual.

## `workflow(name, options, body)`

| Option        | Meaning                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| `version`     | A number. Raise it when the body changes (see the rules below).                                                 |
| `payload`     | The Schema of what a run is started with.                                                                       |
| `returns`     | The Schema of what the body returns. Optional: without it, the run's result is whatever JSON the body returned. |
| `triggers`    | What starts a run by itself. Optional.                                                                          |
| `resumeAfter` | How long a paused run rests before it is tried again. Optional.                                                 |

The body is `Effect.fn(function* (payload) { … })`. Use `yield*` on every call below.

`Schema` is Effect's, version 4. These are all a workflow file usually needs:

```ts
(Schema.String, Schema.Number, Schema.Boolean);
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

| Call                                                                         | Does                                                                                                                                                                                                      | Gives back                                                                                             |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `step(name, { returns, retry? }, effect)`                                    | Runs code once per run. `returns` is the Schema of the result.                                                                                                                                            | The result                                                                                             |
| `agent(name, { brief, project? \| thread?, environment?, output?, model? })` | One agent job in a thread a person can open. Give `project` (a T3 Code project id, or the project's folder as an absolute path) to start a thread, or `thread` from an earlier agent step to continue it. | `{ value, thread }`. `value` is data checked against `output`, or the agent's last message without it. |
| `ask(name, { title, choices, data?, timeout? })`                             | Puts a question to a person.                                                                                                                                                                              | `Option` of `{ choice, reason? }`; none after the timeout                                              |
| `wait(name, { returns, timeout?, key? })`                                    | Sleeps until a signal arrives.                                                                                                                                                                            | `Option` of the signal's value; none after the timeout                                                 |
| `sleep(name, duration)`                                                      | Sleeps, across restarts.                                                                                                                                                                                  | Nothing                                                                                                |
| `title(name, text)`                                                          | Names the run in lists.                                                                                                                                                                                   | Nothing                                                                                                |
| `stop(reason)`                                                               | Ends the run on purpose. It ends as `stopped`, which is not a failure.                                                                                                                                    | Never returns                                                                                          |

`step` retries three times with a growing delay, then pauses the run. Pass
`retry: { times: 0 }` for something that must not be repeated blindly. A step whose failure the
workflow should handle returns the failure as data instead of failing.

`agent` with `output` finishes when the agent submits data that fits the schema, not when its turn
ends. Write the brief as the whole job: the agent sees only the brief and its project.
Find a project's id with the `t3_project_list` tool.
`model` is `{ instanceId, model }`; leave it out for the project's default.

### Agents on other machines

`environment` runs the agent's thread in a linked environment; `project` is then a project there.
A folder there that is not a project yet is registered as one.
The run stays on this server. A continued `thread` stays in the environment it started in, so
only the first step names it.

```ts
const fix =
  yield *
  agent("fix", {
    environment: "environment-id",
    project: "/home/user/app",
    brief: "…",
  });
```

`t3 environment list` prints the linked environments and their ids. Linked environments must be on
in Settings → Labs. What the agent may do there is set by the access the link was paired with.

To use a machine per run, make and link it in a `step` with your own script and return its id:
`t3 auth pairing create --json` on the new machine gives a code, and
`t3 environment link <url> --pairing-code <code> --access <access>` here links it.

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

A webhook workflow filters in its body. Parse `request.body`, and `stop("not a push to main")`
for what it does not care about. To check a signature, do it in a `step`.

A workflow without triggers is started by hand or by another program:
`t3 workflow start <name> --input '<json>' --key <key>`. The same key is the same run.

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
t3 workflow signal '{"choice":"upgrade"}' --run <run> --wait upgrade   # answer a question
t3 workflow signal '<json>' --workflow <name> --key <key>              # wake a keyed wait
t3 workflow hooks                         # webhook URL paths
```

Run states: `running` (also while it sleeps), `waiting` (on an agent, a signal or a question), `paused` (a step failed),
`completed`, `stopped`, `cancelled`.

A paused run shows the failing step and its error in `show`. Fix the cause, then `resume`; only
that step runs again. A paused run is also resumed by itself after 5, 20 and 80 minutes;
`resumeAfter` in the workflow's options changes that. A run whose version is no longer in the file
is marked `retired` in `show --json` and cannot continue until the version is back.

An agent step's thread is an ordinary thread. Open it to see what the agent did, and talk to it if
it is stuck: the step completes when it submits its result.
