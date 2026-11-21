# Usage and limits

Open **Usage** from the sidebar or the command palette, or press `mod+u` on web and
desktop when the terminal is not focused. Customize `usage.open` in
**Settings → Keybindings**.

On mobile, choose **Usage** in the workspace navigation.

## Understand your usage

**Usage** combines Codex, Claude Code, Grok Build, OpenCode, Antigravity, Pi, Muse Code, and Cursor history
from your connected environments. It shows token use, cache savings, model breakdowns, and estimated API-equivalent
cost, split by token type and by speed. These estimates are not your subscription bill.
**Premium** is what Fast and Ultrafast requests cost above standard rates. Cost that cannot be
split, such as a provider-reported cost for a model without public rates, shows as **Other**.
Select a model under **Breakdown** to see its trend, cache hit rate, and cost per million tokens.
Work Lathe does in the background, such as thread titles, commit and pull request text, review
guides, and the roadmap steward, appears under **Breakdown** as its own rows, named for what it was for.

Totals depend on the history available on each server. Grok turns without a saved completed-turn
record are missing from the totals.
Text generation (thread titles, commit messages, PR text, branch names and review guides) is not in
the totals for Codex or Claude Code 2.0.63 and newer, because those runs save no session history.

The server keeps scanned usage history for 92 days by default. Claude Code deletes its own
transcripts after 30 days, so for older Claude usage this history is the only record left. To keep
it longer, set `usageHistoryRetentionDays` in `<Lathe home>/userdata/settings.json` to a number of days
such as `365`, or to `"unlimited"`. Usage views still show at most 90 days. Lowering the value
prunes older history on the next refresh, and raising it again does not bring pruned history back.
While `settings.json` cannot be read, nothing is pruned.

OpenCode reads its SQLite database and older JSON history. Antigravity reads local conversation
databases, including Lathe-managed profiles. Set `OPENCODE_DATA_DIR` or `ANTIGRAVITY_DATA_DIR` on the
server to read a different data directory; comma-separated paths read multiple directories.

Cursor reads account usage from Cursor's API for the account you signed in with in Lathe or set as
`CURSOR_API_KEY`. This includes headless Lathe sessions and desktop usage across machines; the same
account counts once across connected environments. Lathe does not estimate missing tokens from
conversation text.

Usage includes each configured account's history, including disabled accounts. Custom homes follow
the account's home setting or its `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, or `GROK_HOME` environment
variable. Pi reads `~/.pi/agent/sessions`, or the `sessions` directory under
`PI_CODING_AGENT_DIR`. Set `PI_CODING_AGENT_SESSION_DIR` to read a different session directory.
To include sessions saved through `--session-dir` or Pi's `sessionDir` setting, set this environment
variable to the same directory. Pi includes recorded tool and summary costs under `Tools/summaries`.
Muse Code reads native session history, including child sessions, from the home reported by the
configured Muse CLI. Its environment settings, including `XDG_DATA_HOME`, apply. Models without
known prices still contribute tokens and appear as unpriced; set custom prices to estimate their cost.
Use absolute paths or `~/` paths in the account's environment settings; relative environment paths
depend on each project's working directory and cannot be reliably discovered by Usage. Accounts
sharing a history directory count once.

The server saves its first hostname in `<Lathe home>/usage-host-id`, so a recreated container keeps
its usage identity when Lathe home is persisted. Set `LATHE_HOST_ID` to choose the identity
explicitly.

When your app and server support different providers, usage totals may cover only the providers
your app understands. Update the app to include newly supported providers.

On web and desktop, use the environment dropdown to filter costs, tokens, and limits. All
environments are selected by default. The dropdown shows which environments are still scanning;
results appear as each one responds, and figures still updating are dimmed. Cursor shows its last
saved totals first, then updates them when Cursor's API responds.

If recent work is missing or a new model shows no cost, refresh to rescan session history and
update model pricing.

## Set custom model prices

On web or desktop, open the environment dropdown on **Usage**, then choose **Model prices** to add,
edit, or reset a model's estimated price. **Apply to** starts with your current Usage filter;
choose all environments or select individual destinations. Enter the exact model ID and USD
rates per million input and output tokens. You can enter any model ID, including models
without public pricing. When a model on **Usage** has no known price, select it under
**Breakdown** and choose **Set price** to open this table with that model added.

Cache read and cache write rates are optional and use the input rate when blank. Enter `0` for
tokens that are free. Saved prices replace automatic pricing for all of that environment's
history and are shared with clients connected to it. When environments have different prices,
cells show **Mixed**. Edit rates directly in the table, then choose **Save changes** to apply all
edited rows. Untouched cells keep each environment's rate. Select one environment to inspect its
prices. **Reset to automatic** marks a model's override for removal when you save; you can undo
it before saving.

To count one model as another, such as a preview model under its released name, enter the target
model ID under **Map to**. The mapped model no longer appears on **Usage**: its tokens and cost
move to the target model and use the target's price. Clear **Map to** or reset the row to show
the model on its own again.

Each destination reports whether the change saved. Offline or unavailable environments are
marked **Not saved**. Reconnect them and choose **Retry failed saves** to finish the same change
without writing again to environments that already saved. Changes are not queued after you close
the dialog.

## Show only some models

To count only some models, or to leave some out, add `usageModelFilter` to the server's
`settings.json` in its `userdata` directory, such as `~/.lathe/userdata/settings.json`:

```json
{
  "usageModelFilter": {
    "include": [{ "provider": "claude", "model": "orbit-1" }, { "model": "orbit-2" }],
    "exclude": [{ "model": "drift-9" }]
  }
}
```

`include` keeps only the listed models and `exclude` leaves the listed models out. `provider` is
one of `claude`, `codex`, `cursor`, `grok`, `opencode`, `antigravity`, `pi`, or `muse`; omit it
to match a model ID from any provider. Use the model ID that Usage shows without **Map to**, such
as a provider-prefixed ID for Pi. Filters apply before **Map to**, so a model you leave out is not
counted under its mapped name. Usage applies each environment's own filter. Remove the setting to
show every model again.

If the setting is invalid, Usage ignores it and shows every model, and the next save of any other
setting removes it from `settings.json`.

## Track subscription limits

**Usage → Limits** pools every subscription account it can see per provider, so with several Codex
or Claude accounts across your enabled environments and hubs you read one number per window rather than a
list. Each window card shows how much of the pool is left and a bar with one segment per account,
kept in the same column across windows. Accounts are ordered by their next 5-hour refill, soonest
first. For an account with no weekly quota left, this is when its session becomes usable again.
The first available window is used when no account reports a 5-hour limit. A gap means the
account does not report that window. When the provider reports reset times, the card also says
when the next reset lands and how much it hands back. The hatched
part of a segment is what that reset restores. Tap a segment or account row for the account's plan,
where it is signed in, and its reset time. On web, you can hover too. Codex and Claude accounts
with banked reset credits show a ticket count and the **Use reset** action in the account details.
Claude resets are not available when the server runs on macOS, where Claude keeps its login in the
Keychain. On narrow screens, numbered rows below
the bar show each account's quota, countdown, and credits. Tap a row to open its details.

The same account signed in on more than one environment, or reported by a hub as well, counts once.
Filter with the environment dropdown to see what a single machine has.

When a Claude or Codex account has no overall weekly quota left, its pooled session contribution
shows 0% left. The next refill depends on both reset times: an exhausted session must also reset,
and a partly spent session may only regain its unused portion when the week resets. Missing or
stale reset times have no refill estimate; refresh Limits for a new reading. Claude's
model-specific weekly allowances keep their reported values.

Opening Limits checks the selected connected environments automatically. Each client waits at
least five minutes between automatic checks of an environment, including after a failed check.
If a window still looks stale, refresh Limits to re-check every provider and hub.

Pick `/usage-limits` from the composer's command menu, or send it as a message, to check the
current model's limits without leaving the conversation. The result opens above the composer and
closes when you dismiss it or send your next message. It uses the same snapshot as **Usage → Limits**, so it does not run the agent or refresh
anything. The command is offered only for providers that appear under **Usage → Limits**.

To keep them in view on web and desktop, turn on **Usage limits** in **Settings → Appearance → Thread details**, or right-click the thread details card.
The bottom of the thread details card then shows how much is left in each limit window of the
current provider account. Some windows, such as a weekly Opus limit, count only one model. Hover a
row to see when it resets and your pace. Turn on **Context window** to also show the thread's
context use against the model's limit. A tick on the bar marks where the provider compacts
automatically, when it reports that point.

OpenCode Go reports its session, weekly, and monthly allowance when OpenCode runs locally in
the environment. Lathe cannot report limits for external OpenCode servers because their credentials
belong to the remote server. Limits need an OpenCode Go API key, or an OpenCode Console connected
in OpenCode with an API key. A Console browser sign-in alone does not report them. You can also add
your Go API key as `OPENCODE_API_KEY` in the OpenCode instance's **Environment variables**, then
refresh provider status. Cursor reports
its monthly allowance, including separate Auto and API usage, for `CURSOR_AUTH_TOKEN` when it is set,
otherwise for the account you signed in with in Lathe or set as `CURSOR_API_KEY`.
Sign-in and API keys report limits only with Cursor's default API endpoint. If you configure a custom
Cursor endpoint, use an explicit `CURSOR_AUTH_TOKEN` for limits.

Grok reports the remaining subscription allowance and reset time for its current billing period
after signing in with `grok login`. Explicit `XAI_API_KEY` connections and custom authentication
or endpoint configurations do not report subscription limits.

Muse Code reports its session and weekly windows and its tier once the Muse CLI has run in a thread.
Until then it shows no limits. Readings are not kept across a server restart.

API-key accounts may not report subscription limits. This also applies to Claude connections
using a proxy through `ANTHROPIC_AUTH_TOKEN`.

## Connect a CLIProxyAPI hub

To see pooled accounts, open **Settings → Providers → Usage providers → Add source**, pick
**CLIProxyAPI hub**, and enter the hub's URL and management key. The environment you choose is
the one that connects to the hub.

The hub's Codex, Claude, xAI (shown as Grok) and Antigravity accounts appear under **Usage → Limits**;
accounts for other providers are not read. Codex accounts show banked reset credits; select an
account and choose **Use reset** to redeem one. No hub plugin is required.

This connection supplies usage information; configure
the provider separately to send agent requests through the hub. Remove the hub from the same
settings section when you no longer need it.

## Connect a modelproxy gateway

A modelproxy gateway rotates requests across a pool of subscription accounts. To watch that pool
from Lathe, open **Settings → Providers → Usage providers → Add source**, pick **modelproxy
gateway**, and enter the gateway URL together with the OIDC issuer, client ID, and client secret
of the gateway's Lathe client. Then choose **Sign in** on the source's row: Lathe shows a short device code and
a link. Open the link in any browser, on any device, confirm the code, and sign in with your
password and your second factor, either a passkey or the code from your authenticator app. The
row updates on its own when you finish. The server keeps the session and refreshes it; sign in
again only if it says so.

Once signed in, a pill in the thread header shows the account the gateway is serving, its session
and weekly windows against the gateway's rotation threshold, and how long the whole pool is
forecast to last. The pill needs the gateway on one environment only; it finds it from every
thread, whichever environment the thread runs on. Hover it for every pooled account, what each is doing (serving, ready, cooling,
spent, needing a login), and the metered fallback the gateway spills to when the pool is spent.
The same accounts appear under **Usage → Limits**. A single missed read, such as a laptop waking
before its network does, keeps the last reading; the pill shows the gateway offline only when it
has not answered for two refresh intervals, and it reads again as soon as you come back to Lathe.

The pooled accounts are grouped by provider, with the accounts the gateway can use now listed above
the spent or paused ones. Each account takes one line; click it to see every window and when it
resets. Choose rings or meters for the one-line summary under **Settings → General → Gateway
account summary**. While the account list is showing it is live: it changes when the gateway does,
so an account you just added appears within a couple of seconds. Otherwise Lathe reads the gateway every few
minutes. A gateway too old to stream its status is read every five seconds while the list shows.
The dot beside the gateway's name is green while Lathe is following the stream and flashes with
each update. A grey dot means the stream is not connected, so the list may lag the gateway.

### Pick models the gateway routes

A gateway can serve a model name from another upstream, for example `kimi-k3` from OpenRouter.
To offer those names in the model picker, open the Claude instance that sends its requests
through the gateway under **Settings → Providers** and turn on **Show gateway routed models**.
Each routed name then appears in that instance's picker with the upstream beside it, such as
**Claude (iris) · OpenRouter**. Adding or removing a route on the gateway updates the picker
within one refresh; there is nothing to configure in Lathe.

The switch is off by default because Lathe cannot tell which gateway, if any, a Claude instance
talks to, and an instance that goes straight to Anthropic cannot serve routed names. Routes come
from a modelproxy source on the same environment as the Claude instance, so that environment needs
its own signed-in source even when another environment already shows the gateway's pill. If the
gateway cannot be read for a while, the picker keeps the routes it last saw.

## Subscription usage widget

Add **Subscription usage** from your iOS or Android widget gallery to see remaining Codex and
Claude quotas. Tap it to open **Usage → Limits**; on Android this works while Lathe is running in
the background, otherwise open the app from the launcher. On iOS, use **Edit Widget** to choose
Session, Weekly, or both for each provider. Reopen Lathe to refresh expired readings.

## Keyboard shortcuts

On web and desktop, open Usage from the command palette. While on Usage,
press `C`, `T`, or `L` for Cost, Tokens, or Limits while not typing in a field.
Use `Ctrl+Shift+1/2/3/4` (`Cmd+Shift+1/2/3/4` on macOS) for the past
24 hours, 7 days, 30 days, or 90 days. Period shortcuts do nothing on Limits.
Press `Escape` to return to the previous page. Customize these shortcuts in
**Settings → Keybindings**.
