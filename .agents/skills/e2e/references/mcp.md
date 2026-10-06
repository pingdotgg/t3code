# Driving the app over MCP

`e2e mcp` serves a project's live app to a coding agent over MCP (stdio). The
coding agent drives the app the way the testing agent does: look at a screen
before writing a test, check a locator before committing to it. Running tests
and reading a failed run stay on the CLI (topics `running` and `debugging`).

## Setup

The server ships with `e2e`. `e2e init` offers to register it; by hand:

```bash
claude mcp add e2e -- npx e2e mcp   # Claude Code
```

Or declare it in the client's project config (`.mcp.json` for Claude Code,
`.cursor/mcp.json` for Cursor, `.vscode/mcp.json` for VS Code):

```json
{ "mcpServers": { "e2e": { "command": "npx", "args": ["e2e", "mcp"] } } }
```

No model is needed: without the optional `ai` package, sessions open and the
deterministic tools work.

Flags: `--config <path>` names the default config file, `--target <name>`
fixes the target every session opens on, `--headless` hides the browser or
simulator (sessions are headed by default outside CI), `--max-sessions <n>`
sets how many sessions may be open at once (default 4, 1 through 16).

## Tools

Four tools; everything a session can do is a catalog behind `call`.

| Tool            | Does                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open_session`  | Loads the config (`config` names another file; default the nearest `e2e.config.ts`), starts the declared app command if any, boots the engine, opens the app URL, and returns the session id, the catalog, and the first observation. `target` is required when the config declares several. Each session has its own browser or device. |
| `tools`         | The catalog: one line per tool with its argument names (`?` marks optional), the first sentence of its description, and `[read-only]` where it changes nothing. `tools {tool}` shows the full description and the JSON Schema of its arguments.                                                                                          |
| `call`          | Runs one catalog tool: `call {tool: "tap", args: {target: "n42"}}`. Arguments are checked against the tool's schema first; a wrong one fails with `INVALID_ARGUMENT` naming the field.                                                                                                                                                   |
| `close_session` | Saves a recording still running, ends the attempt, disposes the engine, stops the app processes the session started once no other session uses them.                                                                                                                                                                                     |

The catalog, per session:

| Catalog tool                                                                                                                                                                   | Does                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observe`                                                                                                                                                                      | A fresh observation: one node per line as `#id role "name" ...`, plus the current path. On the web engine a link's `href` is its path on the app URL's origin, else origin and path (`mailto:` and `tel:` keep their scheme, `blob:` its inner origin and path); `?…` and `#…` mark a dropped query or fragment, `data:…` and `javascript:…` an inline payload, a trailing `…` a target cut at 256 characters. |
| `tap`, `double_tap`, `long_press`, `right_click`, `hover`, `type`, `press`, `select`, `check`, `scroll`, `scroll_to`, `drag`, `upload`, `navigate`, `back`, `dismiss_keyboard` | The grammar verbs, as the testing agent gets them: `check` takes `checked`, `drag` a `to` node, `upload` project-relative `files`; `dismiss_keyboard` comes with device engines. Each reports what changed on screen; `observe` shows the whole screen. A verb the engine cannot honor is not listed and fails with `UNSUPPORTED_CAPABILITY`.                                                                  |
| `type_secret`                                                                                                                                                                  | Fills a configured secret by name: a credential's password into a password field, a `secrets` entry into any editable input; the plaintext never reaches the agent. Listed when the config declares `credentials` or `secrets` and the engine can fill secrets.                                                                                                                                                |
| `locate`                                                                                                                                                                       | Tries a semantic locator with exactly one of `role`, `text`, `label`, `placeholder`, `testId` (`name` only with `role`; `exact` optional; anything else is `INVALID_ARGUMENT`) and returns how many nodes match, which, and the `screen.*` call to write.                                                                                                                                                      |
| `screenshot`                                                                                                                                                                   | The masked pixels as an image.                                                                                                                                                                                                                                                                                                                                                                                 |
| `tap_at`                                                                                                                                                                       | Taps a point (`x`, `y` in the latest screenshot's pixels): a listed control under it by id, otherwise the bare point, which an engine without a bare-point tap cannot do. Listed when the engine declares `tap` or a bare-point tap.                                                                                                                                                                           |
| `hover_at`                                                                                                                                                                     | Hovers a point the same way: a listed control under it by id, otherwise the bare point. Listed when the engine declares `hover` or a bare-point hover.                                                                                                                                                                                                                                                         |
| `type_at`                                                                                                                                                                      | Types `value` into the field at a point: a listed input under it is filled by id; with a keyboard, anything else is tapped to focus it and typed into, at the caret unless `replace` is set. Without a keyboard a point on nothing listed fails. Listed when the engine declares `type` or a keyboard.                                                                                                         |
| `press_at`                                                                                                                                                                     | Sends one `key` (`Enter`, `Escape`, `Tab`) to the control at a point: a listed control gets it by id; with a keyboard, anything else is tapped to focus it and the key goes through the keyboard. Listed when the engine declares `press` or a keyboard.                                                                                                                                                       |
| `select_at`                                                                                                                                                                    | Picks the option whose visible label is `value` in the select-like control at a point; the point must land on a listed select. Listed when the engine declares `select`.                                                                                                                                                                                                                                       |
| `start_recording`                                                                                                                                                              | Starts a video of the app (`name` optional, for the file name). Listed when the engine records video.                                                                                                                                                                                                                                                                                                          |
| `stop_recording`                                                                                                                                                               | Stops it and returns the absolute path of each video file, under `<output>/videos/<session>/` (`.e2e` by default), or the URL of a provider's own recording.                                                                                                                                                                                                                                                   |
| Project tools                                                                                                                                                                  | Every `defineTool` in the agent's `tools` that applies to the target's platform, under its own name; an engine pack such as `mobileTools` adds `open_app`, `swipe`, `alert`.                                                                                                                                                                                                                                   |

Once a secret is filled in the session, `screenshot` and the point tools
(`tap_at`, `hover_at`, `type_at`, `press_at`, `select_at`) answer with a
`PIXEL_TAINTED` line for the rest of it; act on listed nodes by id (topic
`writing-tests`). Before the session's first `screenshot`, a point tool only
says to take one.

Resources: `e2e://guide` and `e2e://guide/<topic>` hold this skill.

## Workflow

1. `open_session`, then `call {tool: "observe"}` and act until the screen you
   want to test is in front of you. Node ids are valid only for the newest
   observation; an action reports what changed, so observe again before
   using new ids.
2. `call {tool: "locate", args: {...}}` for each locator you intend to write.
   One match: use the printed `screen.getByRole(...)` call. Zero or several:
   adjust before writing the test; the same failure would hit the test as
   `LOCATOR_NOT_FOUND` or `LOCATOR_AMBIGUOUS`.
3. Write `tests/<feature>.e2e.ts` (topic `writing-tests`). Deterministic steps
   where you saw exact names; `agent.act` where the flow varies.
4. Run it from the shell: `npx e2e run tests/<feature>.e2e.ts`, read the
   failure (topic `debugging`), fix, repeat.
5. `close_session` when you are done; an idle session closes on its own after
   30 minutes and never outlives 4 hours. When the client exits, every session
   closes and the app commands stop. To look at another project or config,
   `open_session {config: "path/to/e2e.config.ts"}`; no restart needed.

## Rules

- Record a demo or a bug for a pull request with `start_recording` once the
  screen is set up, and `stop_recording` when the part worth watching is
  over; `close_session` saves one still running. Videos are not masked:
  keep secrets off screen while recording.
- A failed action is an error result that leads with the tool, its target,
  and the code (`tap #n9 failed: LOCATOR_NOT_FOUND: ...`) and still shows
  the screen it re-observed: re-aim from that screen.
- Nothing a session does is recorded as a test or into the replay cache. A
  session is for looking and trying; the test is what you write afterwards.
- A run from the shell and a live session share the app only if the target's
  app `command` sets `reuseExisting` (ignored in CI); otherwise close the
  session before running.
- Parallel agents (subagents) share one server: each opens its own session
  and passes its session id to every `tools`, `call`, and `close_session`.
  A call may leave `session` out only while one session is open. Sessions
  open at once share one config. Sessions on the same app command share its
  process, which stops when the last of them closes. On mobile, two sessions
  on one simulator fight over it: one target per device (topic `setup`), each
  session on its own target.
- `TARGET_REQUIRED`: pass `target` to `open_session` or start with `--target`.
  `UNKNOWN_TARGET`: no target of that name; the message lists the declared
  ones. `NO_SESSION`: call `open_session` first, or the session named has
  ended (the message says why). `SESSION_REQUIRED`: several sessions are open;
  pass `session`. `SESSION_OPEN`: every session slot is taken (close one, or
  raise `--max-sessions`). `CONFIG_IN_USE`: open sessions use another config;
  open on theirs, or close them first. `ENGINE_IN_USE`: the target's engine
  comes from a package every session shares; create it in the config or a
  file it imports by path. `UNKNOWN_TOOL`: the name is not in this session's
  catalog; the message lists what is.
