# Writing tests

## A complete file

```ts
// tests/todos.e2e.ts
import { beforeEach, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

describe("todos", { tags: ["todos"] }, () => {
  beforeEach(async ({ app }) => {
    await app.open("/todos");
  });

  test("adds and completes a todo", async ({ agent, screen, browser }) => {
    await agent.act("add a todo named {title}", { params: { title: "Write the release notes" } });
    await expect(screen.getByRole("listitem")).toHaveCount(1);
    await expect(screen.getByRole("status", "Remaining")).toHaveText("1 remaining");

    await agent.act("mark the todo as done");
    await expect(screen.getByRole("status", "Remaining")).toHaveText("0 remaining");
    await expect(browser).toHaveURL("/todos");
  });

  test("ignores an empty submission", async ({ screen }) => {
    // An exact interaction: the empty submit is the point of the test.
    await screen.getByRole("button", "Add").tap();
    await expect(screen.getByRole("listitem")).toHaveCount(0);
  });
});
```

The agent does the flow; `expect` pins what must be true after each goal,
and that check lets the replay cache rerun the step later. `screen` actions
are for exact interactions and values. Files match the config `tests` glob,
default `tests/**/*.e2e.ts`. In a browser every test starts from a fresh
context with no page open, so it calls `app.open()` first; on a device a test
that skips `app.open()` starts where the previous test left the app.

## Registration

`test` registers everything, and `describe`, `beforeEach`, `afterEach`,
`beforeAll`, and `afterAll` are also top-level imports of the same functions
(`import { describe, beforeEach } from 'e2e'`; `@e2e-dev/web` and
`@e2e-dev/mobile` export `test`, `describe`, and the hooks typed with their fixture; a
`test.extend()` chain registers hooks that see its fixtures through
`test.beforeEach`). Everything registers at import, so a `describe` body is
synchronous (`async` is a `COLLECTION_ERROR`).

```ts
test("title", async ({ app, screen }) => {});
test("title", { tags: ["smoke"], retries: 2, timeout: 60_000 }, async ({ app }) => {});
describe("group", { tags: ["billing"] }, () => {
  /* tests and hooks */
});
describe("checkout flow", { serial: true }, () => {
  /* ordered, shared app state */
});
beforeEach(async ({ app }) => {}); // per attempt, with test fixtures
afterEach(async ({ screen }) => {}); // runs after failures too, with its own cleanup budget
beforeAll(async ({ platform }) => {}); // per suite realm, no app fixtures
afterAll(async () => {});
test.skip("later", async () => {});
test.only("focus", async () => {}); // local only: CI fails with ONLY_IN_CI
test("conditional", async () => {
  test.skip(await onlyOneOrg(), "nothing to switch to");
}); // throws: the body stops here, reported skipped; call it before the first step
test("later", async () => {
  test.skip("waiting on the API");
}); // bare skip from the body
test.setup("sign in", { sessions: ["admin"] }, async ({ app, screen, session }) => {}); // see Sign-in sessions
const wsTest = test.extend<{ ws: Ws }>({
  ws: async ({ browser }, use) => {
    await use(await seed());
    await drop();
  },
});
wsTest("uses the workspace", async ({ ws }) => {}); // code after use() is teardown, runs after failures too
```

A setup test cannot skip from its body (`INVALID_ARGUMENT`).

| Option           | Default                 | Notes                                                                                                                                                                                                                           |
| ---------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeout`        | `config.timeout`, 120 s | Covers `beforeEach` and the body.                                                                                                                                                                                               |
| `retries`        | `config.retries`        | 0 to 10; a serial group's value applies to its members.                                                                                                                                                                         |
| `tags`           | `[]`                    | Distinct, non-blank, no comma or edge whitespace (`'Login Form'` is fine); union across layers. `--tag smoke` selects, `--tag-mode all` requires every tag.                                                                     |
| `skip`           | unset                   | `true` or a reason string.                                                                                                                                                                                                      |
| `platforms`      | unset                   | Only targets with these platforms, e.g. `['ios']`.                                                                                                                                                                              |
| `requires`       | `[]`                    | Engine capabilities, e.g. `['browser']`; missing ones skip the test at selection rather than failing it with `UNSUPPORTED_CAPABILITY`.                                                                                          |
| `session`        | unset                   | Restore state saved by a setup test.                                                                                                                                                                                            |
| `agentContext`   | unset                   | Extra context for `agent.*` calls in this test or group.                                                                                                                                                                        |
| `agent`          | the run's agent         | A configured name (`agents.<name>`) or a list run once per agent; `--agent` narrows the list, a setup test takes one name. Innermost wins; `agent.act(..., { agent })` names another for one call.                              |
| `trace`, `video` | the target's            | `'off'`, `'on'`, `'retain-on-failure'`, `'on-first-retry'`, `'on-all-retries'`. Innermost wins over `--trace` / `--video`, the target, and the config; recording where the engine cannot is `UNSUPPORTED_ARTIFACT` for the run. |
| `serial`         | `false`                 | Groups only. Members share app state, run in order on one worker, retry as a whole, and take the group's `trace` and `video`.                                                                                                   |

Serial members cannot set `retries`, `trace`, `video`, `session`,
`platforms`, `requires`, `skip`, or `only`, nor can a nested `describe` set
`trace` or `video`; nesting serial groups is a `COLLECTION_ERROR`.

Hooks nest: outer `beforeEach` first, inner `afterEach` first. `beforeAll`
reruns per retry and per serial group (each a fresh module realm) on the
test timeout; `afterAll` runs on `config.cleanupTimeout`. A failing
`beforeAll` is a `HOOK_FAILED` run error skipping every test in its scope.

## Fixtures

Built-in fixtures are lazy; destructure them. Your own `test.extend`
fixtures set up for every test registered through that `test`, destructured
or not, so a state-changing fixture belongs on its own `test`.

`app` (`App`) and `screen` (`Screen`): always. `agent` (`Agent`): needs a
configured model, else `MODEL_UNAVAILABLE` (topic `agent`). `platform`
(`string`): always, hooks included; `web`, `ios`, `android`, or an engine's
label. `browser` (`Browser`): browser targets, import `test` from `@e2e-dev/web`.
`device` (`Device`): device targets, import `test` from `@e2e-dev/mobile`.
`session` (`SetupSession`): only in `test.setup`.

### app

- `baseUrl` (`string | undefined`): the target's app URL with the run's
  port; `undefined` when the target declares no `app.url`.
- `open(path?)`: opens the target's `app.url`, a relative path, or an absolute
  http(s) URL. On a device it takes no path and relaunches the pinned app.
- `back()`: one history step back.
- `restart()`: recreates the context keeping persisted state (a restored
  session included), then reopens the base URL.
- `clearState()`: clears cookies and storage, recreates the context, reopens
  the base URL.
- `screenshot(label?)`: saves a redacted screenshot artifact and returns its
  path. Denied after a secret fill (see Sign-in sessions).

`clearState()` is `UNSUPPORTED_CAPABILITY` with `connect.reconnectEndpoint`
or an attempt-scoped browser provider; on a device with no pinned `app`, both
methods are.

## Locators

`screen.getBy*` builds a lazy query, resolved only by an action, read, or
assertion. Every query also exists on a locator, scoped to its subtree.

| Query                                                                                                       | Matches                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getByRole(role, name?, { exact?, checked?, disabled?, selected?, expanded?, pressed?, level?, visible? })` | Semantic role, optionally by accessible name (`getByRole('button', 'Save')`; the object form `{ name }` works too) and state (`level`: heading level 1 to 6). First choice.   |
| `getByLabel(text, { exact?, visible? })`                                                                    | Form controls by label.                                                                                                                                                       |
| `getByPlaceholder(text, { exact?, visible? })`                                                              | Inputs by placeholder.                                                                                                                                                        |
| `getByText(text, { exact?, visible? })`                                                                     | Visible text.                                                                                                                                                                 |
| `getByDisplayValue(value, { exact?, visible? })`                                                            | Inputs by current value; on the web it cannot scope child queries or be a `filter({ has })` target.                                                                           |
| `getByTestId(id, { visible? })`                                                                             | `data-testid` on the web (or `web({ testIdAttribute })`), accessibility identifier or resource id on a device; a string matches the whole id, a RegExp tests it. Last resort. |

Roles: `button`, `link`, `textbox`, `searchbox`, `combobox`, `listbox`,
`option`, `checkbox`, `radio`, `radiogroup`, `switch`, `slider`, `spinbutton`,
`progressbar`, `meter`, `image`, `heading`, `tab`, `tablist`, `tabpanel`,
`menu`, `menubar`, `menuitem`, `menuitemcheckbox`, `menuitemradio`, `toolbar`,
`tooltip`, `tree`, `treeitem`, `list`, `listitem`, `table`, `grid`, `row`,
`rowgroup`, `rowheader`, `cell`, `gridcell`, `columnheader`, `separator`,
`group`, `article`, `figure`, `form`, `status`, `alert`, `dialog`,
`alertdialog`, `main`, `navigation`, `banner`, `contentinfo`, `complementary`,
`region`. The union is closed (anything else is a type error); `img` aliases
`image`; a role the platform lacks (`tooltip` on a phone) matches nothing.
On the web a `contenteditable` host is a `textbox` for the agent and takes
`fill`; from a test use `getByLabel`, `getByTestId`, or `role="textbox"` on
the host.

Text matching is exact after whitespace normalization (whole string,
case-sensitive) for a `getByRole` name, `getByLabel`, `getByPlaceholder`, and
`getByText`: `name: 'Save'` misses `Save changes` (unlike Playwright). A
missed query makes a negated assertion pass, so check it positively.
`getByText` and `getByLabel` return the innermost match, so a container
echoing its child does not count twice. `exact: false` is a case-insensitive
substring; a `RegExp` matches as written.

- Exactly one match per action, read, or assertion. Two fail at once with
  `LOCATOR_AMBIGUOUS`; at zero, actions and assertions poll until the
  timeout then `LOCATOR_NOT_FOUND`, a read fails at once. Exceptions:
  `toHaveCount`, `toBeVisible`, `toBeHidden`, `toBeAttached`, list-form
  `toHaveText` and `toContainText`, `isVisible()` (false at zero),
  `isHidden()` (true), `count()`, `all()`, `allTextContents()`.
- Narrow with `filter({ hasText })` (a case-insensitive substring, unlike a
  query), `filter({ has: locator })`, `first()`, `last()`, `nth(i)`, or
  scoping under another locator. Any other `filter` key (`hasNot`,
  `hasNotText`) or an empty `filter({})` is `INVALID_LOCATOR`.
- `visible: true` drops nodes the page hides (a closed drawer) before the
  exactly-one rule. Visibility is what renders, as `toBeVisible()` reads it:
  an `aria-hidden` spinner that paints is visible, so `toBeHidden()` waits
  for it to go.
- On the web, queries reach open shadow roots and closed roots attached with
  `attachShadow`, not declarative closed roots. `browser.locator(css)`,
  `frameLocator`, and `filter({ hasText })` stop at a closed root; query the
  text inside or filter with `has`.
- `screen.scrollUntilVisible(locator, { direction?, momentum?, timeout? })`
  scrolls the viewport (`down`, `slow` by default) until the locator resolves
  visibly, else `LOCATOR_NOT_FOUND`; on a locator it scrolls that node.

### Actions

Each action resolves one node, waits up to `config.actionTimeout` (30 s, or
`{ timeout }`) for it to be actionable, and does one thing: `tap()` (alias
`click()`), `doubleTap()`, `secondaryTap()` (each takes
`{ modifiers: ['Shift'] }`), `longPress({ duration? })`
(100 to 10000 ms; default 500 on the web, 1000 on a device),
`fill(value | Secret)`, `pressSequentially(text, { delay? })`, `clear()`,
`press(key)`, `check()`, `uncheck()`,
`selectOption(label | { label } | { value } | { index })` (one option; an
array is `INVALID_ARGUMENT`), `focus()`, `hover()`, `setInputFiles(paths)`
(relative to the project root), `dragTo(locator)`, `scrollIntoView()`,
`swipe({ direction, momentum? })`. Web only, `UNSUPPORTED_CAPABILITY` on a
device: `secondaryTap`, `selectOption`, `setInputFiles`, `scrollIntoView`,
and `modifiers`.

`fill` sets the value with no key events; when the app reacts to keystrokes
(autocomplete, a masked input) use `pressSequentially`, which focuses the
field and types one character per `delay`, plain string only (a `Secret` is
`INVALID_ARGUMENT` and goes through `fill`).

Coordinates are CSS pixels, for what the tree does not list: `tap({ position:
{ x, y } })` offsets from the node's top-left corner (with `modifiers` it is
`INVALID_ARGUMENT`), `screen.tapAt({ x, y })` taps a viewport point,
`screen.swipe({ from, to })` swipes along a path,
`screen.swipe({ direction, momentum? })` swipes the viewport. Prefer a
locator; a point moves with the layout.

### Reads

Reads resolve once, no retry: `textContent()`, `inputValue()`,
`getAttribute(name)`, `isVisible()`, `isHidden()`, `isEnabled()`,
`isDisabled()`, `isChecked()`, `boundingBox()`, `count()`. `all()` gives one
`nth(i)` locator per current match and `allTextContents()` every match's
text, both `[]` at zero. Text is the rendered text, whitespace collapsed: on
the web what `innerText` reads (`text-transform` applies, `display: none`
drops out, `<br>` is a space); `toHaveText` reads the same. `isChecked()` is
`false`, not an error, on a node with no checked state, so query checkable
controls by role. `waitFor({ state?: 'attached' | 'detached' | 'visible' | 'hidden', timeout? })` waits
within `actionTimeout`, else `LOCATOR_NOT_FOUND`. For a value that has to
settle use `expect`, not a read. Reading a password field's value or
attributes is `POLICY_DENIED`, as is `toHaveAttribute` on one, negated too.

## expect

`expect(locator)` polls up to `config.assertionTimeout` (5 s) or
`{ timeout }`; `.not` inverts and passes once the negation has held 1 s
continuously, or for the whole `timeout` when that is shorter, so it never
returns sooner. `expect(value,
message?)` is synchronous.
`expect.poll(read, { timeout?, interval?, message? })` re-reads until a value
matcher passes (`assertionTimeout` and 100 ms by default, stopping with the
attempt); a throwing read keeps polling, and it is not a report step. A
poll that the body or a hook returns without awaiting is cancelled and fails
that phase with `STEP_NOT_AWAITED`.
`expect.soft(x)` keeps a failure instead of throwing; the attempt fails
after the body with every soft failure listed. If the body calls `test.skip`,
the test stays skipped and the failures remain in `secondaryErrors`. The CLI
shows `Skipped After Failure`, also when a retry skips after an earlier
failure. Set `failOnSkippedFailure: true` in the config to fail the run with
exit code 1 in either case. The default is `false`; clean skips stay green.
`expect.any(Class)`, `expect.anything()`, `expect.objectContaining(obj)`,
`expect.arrayContaining(arr)`, `expect.stringContaining(s)`, and
`expect.stringMatching(s | RegExp)` stand in for values inside `toEqual`,
`toMatchObject`, `toContain`, and `toHaveProperty`.

```ts
await expect(screen.getByRole("dialog")).not.toBeVisible({ timeout: 10_000 });
await expect(browser).toHaveURL("/dashboard"); // relative to the base URL, or a RegExp
expect(order).toMatchObject({ id: expect.any(Number), lines: [{ sku: "a" }] });
expect.soft(await screen.getByTestId("tax").textContent()).toBe("$8.00"); // kept, body runs on
const users = expect(await response.json()).toMatchSchema(z.array(User)); // any Standard Schema; typed output
```

`toMatchSchema(schema)` takes a synchronous Standard Schema (Zod, Valibot,
ArkType), fails listing every issue by path, and returns the parsed value
typed; prefer it when the app already has a schema for the response.

| Locator matchers                                                                                                                                                                                                                                 | Browser matchers                                             | Value matchers                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toBeVisible`, `toBeHidden`, `toBeAttached`, `toBeEnabled`, `toBeDisabled`, `toBeChecked`, `toBeSelected`, `toBeExpanded`, `toBeFocused`, `toHaveText`, `toContainText`, `toHaveValue`, `toHaveAttribute`, `toHaveCount`, `toHaveAccessibleName` | `toHaveURL`, `toHaveTitle`, `toHaveClass(locator, expected)` | `toBe`, `toEqual`, `toMatchObject`, `toBeTruthy`, `toBeFalsy`, `toBeNull`, `toBeUndefined`, `toBeDefined`, `toHaveLength`, `toHaveProperty`, `toContain`, `toMatch`, `toBeGreaterThan`, `toBeGreaterThanOrEqual`, `toBeLessThan`, `toBeLessThanOrEqual`, `toBeCloseTo`, `toMatchSchema` |

`toHaveText` compares the whole normalized text, `toContainText` a substring
or RegExp, `toHaveValue` a form control's value as is, whitespace included
(it fails on a node with none); on a password field all three are
`POLICY_DENIED`, never a comparison against `''`. List forms:
`toHaveText(['Alpha', /^Beta/])` needs exactly two matches with those texts
in order; `toContainText(['Alpha', 'Beta'])` needs each entry in a distinct
match, in order, extra matches allowed. `toHaveAttribute(name)` checks
presence, `toHaveAttribute(name, value)` the value; `toBeAttached` waits for
a match, hidden or not; `toHaveClass` compares the whole normalized class
list or tests a RegExp. A failed matcher is `ASSERTION_FAILED`, exit code 1.

Playwright's `{ checked: false }`, `{ enabled: false }`, `{ visible: false }`,
and `{ attached: false }` flip their matchers, and `{ ignoreCase: true }`
works on `toHaveText`, `toContainText`, `toHaveAccessibleName`,
`toHaveAttribute(name, value)`, and `expect(browser).toHaveURL`. Any other option, `indeterminate` or
`useInnerText` included, is `INVALID_ARGUMENT`, in JavaScript too.

## Sign-in sessions

Sign in once in a setup test, save the state under a name, and let other
tests declare it. Selecting a dependent test alone still runs its setup.

```ts
// tests/auth.setup.e2e.ts
import { test } from "@e2e-dev/web";
import { expect, credentials } from "e2e";

test.setup(
  "authenticate as admin",
  { sessions: ["admin"] },
  async ({ app, screen, session, browser }) => {
    const admin = credentials.user("admin");
    await app.open("/login");
    await screen.getByLabel("Email").fill(admin.username);
    await screen.getByLabel("Password").fill(admin.password);
    await screen.getByRole("button", "Sign in").tap();
    await expect(browser).toHaveURL("/dashboard"); // prove the sign-in worked before saving
    await session.save("admin");
  },
);
```

```ts
// tests/dashboard.e2e.ts
import { test, expect } from "e2e";

test("the dashboard opens directly", { session: "admin" }, async ({ app, screen }) => {
  await app.open("/dashboard");
  await expect(screen.getByRole("heading", "Dashboard")).toBeVisible();
});
```

- Setup tests are top-level; exactly one setup saves a given name and the
  body saves every declared name once (`SESSION_CONTRACT` otherwise). Names
  match `[A-Za-z0-9_.-]{1,128}`.
- A session holds cookies, local storage, and IndexedDB for one run,
  encrypted and deleted at cleanup; server state is not part of it.
- Once a secret is filled, model pixels and assertion screenshots are
  withheld for the rest of that session (later serial members included) and
  `app.screenshot()` is `POLICY_DENIED`. A restored session keeps its setup's
  taint; a setup that signs in without a fill (`browser.setCookies`, say) leaves
  screenshots available.
- Credentials live in the config, values in the environment:

```ts
credentials: {
  admin: { username: 'admin@example.test', password: process.env.ADMIN_PASSWORD ?? '' },
},
```

- A static password or secret needs 6 or more code points, else
  `INVALID_CONFIG` at config load, so an unset variable fails every command.
  A function is read at fill time and redacted only from that fill on.
- `E2E_USER_<NAME>_USERNAME` and `E2E_USER_<NAME>_PASSWORD` override either
  field per run, even over a function; `<NAME>` is the credential name
  uppercased, every character outside `[A-Z0-9]` as `_`. Two credentials (or
  two secrets) mapping to one variable, `svc-a` and `svc_a`, are
  `INVALID_CONFIG`.
- `credentials.user('admin').password` is a `Secret` with no plaintext
  accessor, named `admin.password` to the agent and in reports; `secrets.get()`
  never returns it (separate namespaces). Only `fill()` and `agent.act` params accept it, stringifying it
  is `INVALID_CONFIG`, and `credentials.user()` outside a run throws
  `AUTH_CREDENTIAL_UNAVAILABLE`.
- Any other sensitive value (an API key) is a `secrets` entry,
  `secrets: { 'stripe-key': process.env.STRIPE_KEY ?? '' }`, overridable with
  `E2E_SECRET_STRIPE_KEY`; `secrets.get('stripe-key')` is the same kind of
  handle, fills any editable input, and is redacted by name everywhere the
  runner writes.
- A registered value passed as a plain string (`process.env.STRIPE_KEY` in a
  title, a URL, a locator, an `agent.act` instruction or param) is redacted
  too: reports, step labels, the executor, and the model see
  `<secret:stripe-key>` (and so does the test id, for a value in a title),
  so the agent cannot type it. Pass the handle.

## The browser fixture (browser only)

Prefer `app` and `screen`; `browser` is for what only a browser has, and a
portable suite declares `requires: ['browser']`. Page methods act on the one
active tab; cookies, routes, and `onDialog` cover the whole browser. A tab
the app opens itself (`target="_blank"`, `window.open`) is not followed:
`browser.goto` its URL instead.

- `goto(url, { waitUntil?, timeout? })`, `reload({ timeout? })`,
  `back({ timeout? })`, `forward({ timeout? })`: navigation on the test
  timeout by default; `goto` takes a base-relative path.
- `url()`, `title()`, `waitForURL(url | RegExp, { timeout? })`: reads and a
  URL wait; `waitForURL` matches like `toHaveURL`.
- `locator(css)`: raw CSS or XPath; not portable, a last resort.
- `frameLocator(css)`: a `Screen` scoped to one iframe
  (`browser.frameLocator('#payment').getByLabel('Card number')`); keeps
  `locator(css)` and `frameLocator(css)` for nesting.
- `evaluate(fn | source, arg?)`: runs a function or source string in the
  page, JSON in and out, no closures; a throw in the page is
  `EVALUATE_FAILED`.
- `addInitScript(source | { path } | fn)`, `addInitScript(fn, arg)`: runs
  before the page's own scripts; call it before `app.open`. `arg` is JSON.
- `route(pattern, handler)`, `unroute(pattern)`: intercept requests, newest
  route first; `route.request` has `url`, `method`, `headers`, `postData`.
  The handler calls exactly one of
  `fulfill({ status?, headers?, contentType?, json | body | path })`,
  `continue({ url?, method?, headers?, postData? })` (straight to the
  network), `fallback()` (the route registered before it), or `abort()`;
  none or two fails the next step with `ACTION_FAILED`, an unsupported
  option with `INVALID_ARGUMENT`.
- `waitForResponse(pattern, { timeout? })`: resolves once the headers
  arrive, with `{ url, status, headers, json(), text() }`; `text()` and
  `json()` wait for the body (up to the action timeout) and reject with
  `ACTION_FAILED` when it could not be read.
- `cookies()`, `setCookies([...])`: a target is an http(s) URL or a domain.
- `setViewport({ width, height })`: resize.
- `onDialog('accept' | 'dismiss' | handler)`: awaited; resolves to an async
  unsubscribe. Register it before the tap that opens the dialog. A handler
  gets `{ message, accept(text?), dismiss() }`, `accept` taking the prompt
  text; no handler, or one that neither accepts nor dismisses, fails the
  next step with `INVALID_STATE`.
- `waitForDownload(() => trigger, { timeout? })`: returns
  `{ path, suggestedFilename }`.
- `keyboard.press(key)`, `keyboard.type(text)`, `mouse.*`: unfocused input;
  prefer `locator.press` and `locator.fill`.

A `route`, `unroute`, or `waitForResponse` pattern is a glob string or
`RegExp` matched against the full URL (`*` stays within one path segment,
`**` crosses `/`, `?` is one character); a predicate function is
`INVALID_ARGUMENT`.

## Habits

- Selectors come from the source (labels, roles, text); add an `aria-label`
  or heading where the app has no accessible name rather than fall back to
  `browser.locator('.btn-primary')`.
- Test data gets a run-unique name (`Invoice ${Date.now()}`) and `afterEach`
  cleanup, so replays and retries never trip over leftovers.
- APIs live in the same suite: `fetch(new URL('/api/users', app.baseUrl))`
  plus value matchers, in a `test.extend` fixture that reads `browser.cookies()`
  when the API needs the session.
- No sleeps or polling loops; a matcher with a longer `timeout` instead.
- `await` every step call and `expect.poll`, else `STEP_NOT_AWAITED` at the line of the call.
- Assert the fact a model produced with `toContain`, not its exact sentence.
