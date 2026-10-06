# Agent steps

`agent` is a fixture like `screen` and the main way a test drives the app.
Each call is one bounded invocation: fresh redacted observation, deadline,
model-call budget, no shared transcript. No agent step, no model calls.

## Configure a model

Put an AI SDK model under `agents.default`. You can use all AI SDK providers
that support tool calls and the language model specification v2 or later
(https://ai-sdk.dev/providers). Examples: `@ai-sdk/openai`,
`@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/amazon-bedrock`,
`@openrouter/ai-sdk-provider`, `ollama-ai-provider-v2`. For a server with
`/v1/chat/completions`, use `@ai-sdk/openai-compatible`. Vercel AI Gateway
reads `AI_GATEWAY_API_KEY` or, without it, a Vercel OIDC token:

```ts
import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import { gateway } from "ai";

export default {
  targets: [{ engine: web(), app: { url: "http://127.0.0.1:3000" } }],
  agents: { default: { model: gateway("openai/gpt-6-luna-fast") } },
} satisfies E2EConfig;
```

Subscription logins and local models:
[setup](setup.md#subscriptions-and-api-keys). Keep `ai@^7` installed with
any provider.

- Pass a model instance, not a string (`INVALID_CONFIG`).
- An agents entry is one plain object of `model`, `judge`, `system`,
  `context`, `tools`, `maxSteps`, `maxModelCalls`, `judgmentTimeout`,
  `maxObservationBytes`, `maxInputTokens`, `providerOptions`, or `executor`
  for a custom brain; none inherits `model` or `context` from `default`.
- `model` drives `agent.act`. Judgments use `judge` when set, else `model`.
- A missing model for the built-in agent raises one run-level
  `MODEL_UNAVAILABLE` when the first test acquires `agent`, exit 2; auth
  failures surface on the first model call as `MODEL_PROVIDER_FAILED`, or as
  `CONFIG_LOAD_FAILED` for a provider that reads its key when the config loads.
- `context` is what the app calls things, sent to every model call, judges
  included; `system` is how the acting agent works, read only by the act
  loop. Both live on the agents entry; `agentContext` on a test or group
  adds more.

### Choose an agent

Tests use `agents.default` unless selected otherwise:

- `e2e run --agent buyer` picks another configured agent.
- `{ agent: 'buyer' }` on a test or group pins that agent; a list such as
  `{ agent: ['buyer', 'admin'] }` runs each test once per agent.
- `--agent buyer,admin` runs unpinned tests for both, narrows a pinned list
  to matching names, never replacing a pin it does not name.
- `{ agent: 'name' }` on an `agent.*` call overrides the test's choice.

For signed-in personas, pair an agent with a `session` in a describe block
repeated per persona; the cache keys every entry by the agent and its
context, so each persona records and replays its own steps.

## act: one goal

```ts
import { credentials } from "e2e";

await agent.act('add a todo named "Buy milk" and mark it done');
await agent.act("invite {email} as an editor", { params: { email: "ada@example.test" } });

const member = credentials.user("member");
await agent.act("sign in with the given credentials", {
  params: {
    username: member.username,
    password: member.password, // a Secret: the model sees its name, the runner fills the field
  },
});
```

`act(instruction, options?)` runs a multi-action flow to a verdict. Passed
resolves with `summary`, `modelCalls`, `actions`, and `cache` (the replay
cache's part). Failed or blocked throws an `AgentError` whose `code` says
why: `ACTION_FAILED` (product failure); `STEP_BUDGET_EXHAUSTED`,
`STEP_TIMEOUT`, `CONTEXT_OVERFLOW` (out of room);
`AUTH_CREDENTIAL_UNAVAILABLE`, `AUTH_CREDENTIAL_INVALID`,
`SECRET_UNAVAILABLE`, `ENVIRONMENT_UNAVAILABLE`, `SEED_DATA_MISSING`,
`TEST_SETUP_FAILED`, `AUTOMATION_UNSUPPORTED`, `POLICY_DENIED` (blocked
from outside);
`MODEL_OUTPUT_INVALID` (unusable answer). Full list: topic debugging.

Options:

- `params`: values the instruction names; the runner fills a `Secret`,
  and a run-unique `unique(\`E2E ${Date.now()}\`)` keeps the cache working
  across runs.
- `timeout`: the config `timeout`.
- `maxSteps` (default 25 actions), `maxModelCalls` (default 25): may only
  lower the agent's limits, else `INVALID_ARGUMENT`.
- No `schema` (use `extract({ schema })`) and no `vision`: the model decides
  when it needs pixels.

The tools, one per engine action. Name the target as the screen names it
(files in `params`); the agent picks the verb:

- `observe`: re-read the screen after waiting on work in progress.
- `tap`: button, link, menu item, tab, checkbox, row, field.
- `double_tap`/`long_press`/`right_click`: second-click item, long-press
  menu, context menu only.
- `hover`: menus, flyouts, tooltips that open on the pointer.
- `type`: one input; on browser/device no target means focus; `replace` clears.
- `press`: one key to a node or, on browser/device, to focus; `times` up to 20.
- `select`: one option by visible label.
- `check`: set a checkbox, switch, or radio to a state, not flip it.
- `scroll`: viewport or one scrollable node, a screen or a few.
- `scroll_to`: a listed node into view, or by `text` page a list to a row.
- `drag`: one node onto another.
- `upload`: project-root files to a file input; outside it or hidden (`.env`)
  is `POLICY_DENIED`.
- `navigate`: a URL or app-relative path.
- `back`: browser history or in-app back.
- `type_secret`: a declared secret by name; plaintext never reaches the model.
  Offered only when the step declares secrets and the engine can fill them.
- `screenshot`: attach viewport pixels; every later result then carries one.
- `tap_at`/`hover_at`/`press_at`/`select_at`/`type_at`: a screenshot point.
- `dismiss_keyboard` (device): hide the on-screen keyboard.

The focused field's selected text is listed as `selection="..."` (never for
a secret), so a repeated `Shift+ArrowLeft` selects one word with visible
feedback. Point tools serve a canvas shape, map pin, image region, or system
sheet control, hit-testing the tree first so a listed control underneath is
acted on by id; `type_at` on nothing listed taps, then types. A screen with
nothing to tap by id opens with a screenshot attached. A device has no
`right_click`, `select`, `upload`, or `scroll_to` by node id. Pixels are
masked and withheld after a secret fill (topic writing-tests): act on pixels
before signing in, or in a test of its own. A result says when an action
closed an on-screen keyboard; on a touch screen that tap was often spent
closing it, so act again.

## assert, waitFor, extract: one question

```ts
import { z } from "zod";

await agent.assert("the dashboard shows a trial badge"); // one look, one judgment

await agent.waitFor("the export finished and a download link appeared", {
  // polls
  interval: 500,
  timeout: 120_000,
});

const data = await agent.extract("every todo title and how many remain", {
  // structured output
  schema: z.object({ titles: z.array(z.string()), remaining: z.number().int() }),
});
expect(data.titles).toContain("Buy milk");
```

- `assert` does not poll. False is `ASSERTION_FAILED` with the model's
  explanation and a screenshot in the report; too little on screen to
  decide is `ASSERTION_INCONCLUSIVE`, also a failure, so reach the right
  screen first and ask about what is visible. Judged from the tree alone,
  it adds `pass vision: true when the answer is in pixels`, as does
  `waitFor`'s timeout after an inconclusive round.
- Judgments see the assertion and the current screen only, never prior
  steps or the act loop's summaries; malformed output gets one repair
  round, then `MODEL_OUTPUT_INVALID`.
- `waitFor` observes every `interval` (default 3 s), judges only when the
  screen changed, and is `STEP_TIMEOUT` after `timeout` (default 30 s).
- `extract` takes any Standard Schema validator (zod works); the model sees
  the schema's shape, never its value rules (`min`, `max`, lengths,
  patterns), which check what it read. Data the screen does not show is
  `ASSERTION_INCONCLUSIVE` naming what was missing, never `""` or `0`; to
  accept absence, ask for it (`'the phone, or null when none is shown'`
  with `.nullable()`).

`vision` on a judgment picks the evidence: `false` (default) the tree;
`true` the tree plus a masked screenshot; `'only'` the screenshot alone, for
what the screen presents (an overlay, a broken layout, a chart) where the
tree would answer first. `'only'` never falls back to the tree: unprovably
masked pixels fail with `POLICY_DENIED`.

## Write instructions the model can execute

- One goal per `act`; goal order is the test's, the path the model's.
- Use the words on screen: `'open the Billing tab'`, not `'upgrade'`.
- Values go in `params`, never expanded: `act('rename to {name}', { params })`.
- Do not describe mechanics the runner handles: waiting, scrolling, retries.
- Pin every `act` outcome right after it; that check lets the cache record:

```ts
await agent.act('create a workspace named "Atlas" on the Pro plan');
await expect(screen.getByRole("status")).toHaveText('Created "Atlas" on the Pro plan');
```

The model gets the instruction verbatim plus the params as a separate
block; the check also makes the test model-portable. Off-screen state (a
database row) can land after `act` returns; `expect.poll` the read instead
of sleeping.

## What the model sees

A redacted snapshot of the screen (roles, names, text, states), prior-step
summaries, and your context; never raw HTML, cookies, headers, environment
values, or a `Secret`'s value; password fields masked. The first
screen of a step arrives whole; later action results report what changed,
keyed by node ids stable while an element exists, or the whole screen when
most changed. Pixels arrive through `vision` on a judgment or the act loop's
`screenshot` and point tools, masked and withheld after a secret fill. When
the browser engine's tree capture times out, the model gets a screenshot and
a warning, a judgment needs `vision: true`, and no control may be inferred
absent nor old node ids reused. Nothing the model returns runs as code or
selectors: the runner validates and authorizes every tool call first.

## Budgets and cost

| Call      |                              Model calls | Default timeout             |
| --------- | ---------------------------------------: | --------------------------- |
| `act`     | up to `agents.<name>.maxModelCalls` (25) | the config `timeout`, 120 s |
| `assert`  |                                        2 | 30 s                        |
| `extract` |                                        2 | 30 s                        |
| `waitFor` | up to `agents.<name>.maxModelCalls` (25) | 30 s                        |

- Slow model calls: raise the step or test `timeout` for `act`, the agent's
  `judgmentTimeout` for judgments, `actionTimeout` for slow UI.
  `STEP_TIMEOUT` and `STEP_BUDGET_EXHAUSTED` fail the test; smaller goals
  help.
- `--debug` prints phase timings and a per-step table (duration, model
  calls, tokens, cache share, cost) to stderr and saves step transcripts as
  artifacts.

## The replay cache

A passing `agent.act` saves its actions once a later check verifies the
outcome; the next run replays them without model calls, and the live agent
continues from the current screen when the app or final state no longer
matches. Misses and hand-offs use the model; `agent.assert`,
`agent.waitFor`, and `agent.extract` are never cached.

- On by default (`read-write`), `read-only` in CI, off via `cache: 'off'`
  or `--no-cache`. Entries live in `.e2e/cache/`; deleting the directory
  only slows the next run.
- An entry is written only after a later verification passes (a locator or
  engine `expect` matcher, `locator.waitFor`, `browser.waitForURL`,
  `agent.assert`, `agent.waitFor`), so an unchecked `act` never replays; a
  plain-value `expect`, `expect.poll`, `agent.extract`, another `act`, or
  the attempt passing confirms nothing.
- A replay needs the app on the recorded route (origin, path, and query,
  ids and tokens aside; unless the recording opens with a navigation),
  re-finds each control by role, name, test id, placeholder, input purpose,
  and its named row (an unnamed control with twins and no named container
  hands off), and passes alone only when the recorded end route is back,
  every control that appeared (with its checked or selected state) is
  there, every one that went away is gone, at least one of those changed
  during the replay, and no new alert showed; otherwise the agent takes
  over mid-step. Entries are keyed per agent and per `agentContext`. `step.cache.reason` says why: `no-entry`,
  `wrong-context`, `target-not-found`, `target-ambiguous`, `end-mismatch`,
  and so on.
- A step recording no actions, or changing nothing on screen or in the
  route, creates no entry; one whose `unique()` value
  equals, is spelled inside, or is the encoded form of another param's value
  is not recorded either (`step.cache.notRecorded`: `param-collision`).
- `e2e init` gitignores `.e2e/cache/`; remove that line to commit entries
  and share replays with CI and teammates (CI stays `read-only` unless
  `cache: 'read-write'` is set).
- A failing run evicts the entries it implicates; `--no-cache` rules the
  cache out of a failure. A cancelled run and a failure where no model
  answered (`MODEL_PROVIDER_FAILED`, `MODEL_UNAVAILABLE`) implicate nothing
  and evict nothing.
- With committed recordings, `--strict-cache` in CI fails a recording that
  no longer replays with `REPLAY_STALE` instead of quietly spending model
  calls every run; re-record locally and commit. Unrecorded steps still run
  live.

## Inspect what the model did

```bash
npx e2e run tests/checkout.e2e.ts --debug      # step table, transcripts as artifacts
npx e2e run tests/checkout.e2e.ts --ai-trace   # writes <output>/ai-trace.json (.e2e/ai-trace.json by default)
npx unbox-ai runs .e2e/ai-trace.json                        # one line per agent step
npx unbox-ai summary .e2e/ai-trace.json --run 0             # turns, tokens, tool calls of one step
```

Never read the trace directly: megabytes of resent context, images replaced
by byte counts. `--no-cache` traces the whole flow, since replayed steps
make no model calls.

## Make the agent yours

1. **The goal.** A failed step usually named something the screen does not;
   reword it with on-screen labels, and `--debug` shows what the model saw
   and tried.
2. **`context`.** Vocabulary every step needs (plan names, what a
   "workspace" is, which tab holds billing), once on `agents.<name>.context`
   or per test via `agentContext`.
3. **`system` on the agent.** How carefully it verifies, what it never
   does, how it treats a modal; a UX reviewer, a cautious QA persona, and a
   fast smoke agent are three `system` prompts on one model.
4. **Tools.** A test API the agent may call mid-flow (seed a cart, mint a
   coupon) via `tools`; see below.
5. **The model and its options.** `providerOptions` for reasoning effort,
   or another model for one persona. `--agent <name>` runs the suite as any
   configured agent, comparing candidates on the same tests; every result
   records which agent ran it.

## Beyond the built-in agent

- `tools: { seedCart }` on an agents entry adds AI SDK tools wrapped with
  `defineTool(tool({ ... }), { mutates: true })` from `e2e/agent` for a
  test API a flow calls mid-step.
- `createToolLoopExecutor` keeps the loop and replaces prompt and tool
  vocabulary.
- Any `StepExecutor` (`{ name, version?, cache?, runStep(ctx) }`) goes under
  `executor`; the runner still owns observations, actions, budgets, and the
  report, and `system` or `tools` beside `executor` is `INVALID_CONFIG`.

Reference: https://e2e.tester.army/docs/agents

## In CI

Run the suite, agent steps included, on every pull request, passing the key
the config's model reads (`env: { AI_GATEWAY_API_KEY }` for `gateway()`)
from secrets. Sharing `.e2e/cache/` lets CI replay verified action steps
without model calls; CI defaults (`read-only` cache, retries): topic running.
