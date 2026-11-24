# LiteLLM

HYR Code can run Claude, Codex, and OpenCode through a [LiteLLM](https://docs.litellm.ai)
gateway with the LiteLLM CLI (`lite`). Each harness keeps working as usual, but it signs in
with your gateway's SSO and uses the gateway's models. This lets you, for example, use a
GPT model on the Claude harness.

## Set Up LiteLLM

1. On the machine that runs the HYR Code server, install the LiteLLM CLI 1.102.0 or newer
   and the harnesses you want to use:

   ```sh
   uv tool install 'litellm[cli]'
   ```

2. Set `LITELLM_PROXY_URL` to your gateway URL in your shell profile, for example
   `export LITELLM_PROXY_URL=https://litellm.example.com`. The desktop app reads it from your
   login shell. You can also set it in a provider instance's **Environment variables**.
3. In **Settings > Providers**, choose **Add provider**, pick Claude, Codex, or OpenCode,
   and turn on **Launch through LiteLLM**. The suggested label is, for example,
   **LiteLLM Claude**, and that is the name the model picker shows. To route an existing
   provider instead, such as the built-in Codex or Claude, open it and turn on
   **Launch through LiteLLM**.
4. Choose **Sign in**, then **Open browser**, and finish your gateway's SSO sign-in.

You keep one LiteLLM sign-in per user account on the server. All LiteLLM instances share it,
and signing in or out on one instance applies to all of them. `lite` renews the key on its own
for up to 14 days; after that, sign in again.

A running agent keeps the key and the model list it started with. Each new thread starts its
own agent. After a renewal or a change to the gateway's models, HYR Code restarts an idle agent
before its next message and resumes the conversation. If a key still expires during a turn,
and that turn had not run any commands or edits yet, HYR Code sends your message again once.

If `lite` can no longer renew the key (after 14 days, or if the gateway revoked it), the
provider shows as signed out and your message is not sent. Sign in again, then send it again.

If you sign in from another device and the final `localhost` page does not load, copy its
full URL and paste it in HYR Code when it asks.

## Models

- **LiteLLM Claude** lists every model the gateway offers.
- **LiteLLM Codex** and **LiteLLM OpenCode** list the models that `lite` syncs into those
  harnesses.

In the model picker and in **Settings > Providers**, a **LiteLLM** label marks each model the
gateway serves. A model without the label comes from the harness's own list. LiteLLM OpenCode
sends those models to their usual provider, not to the gateway.

HYR Code checks the gateway's model list at most once a minute, and **Refresh** in
**Settings > Providers** checks it now. If the gateway removes the model a thread uses, the
model picker marks it unavailable and the next message fails until you select another model.

The gateway translates between model families, so effort and thinking controls might not
apply to every model.

## Cost and Budget

On web and desktop, enable **Usage limits** in **Settings > Appearance > Thread details**
to see **Proxy cost (est.)** after a turn with known gateway rates. The estimate covers the main agent in the loaded turns. It excludes
subagents and background work. A `+` means some loaded turns have no price. Earlier turns
can be included when you load more history. Each priced turn keeps its estimate when rates
change. This is an estimate, not billed spend.

HYR Code reads your budget from the gateway's `/user/info` and rates from `/model/info`, with
the key from your existing `lite` sign-in and `LITELLM_PROXY_URL`. The budget appears in thread
details, **Usage > Limits**, and `/usage-limits`. It is your user budget, so it includes other
clients and keys you use. Refresh the provider to check it now; automatic checks use the
one-minute provider cache. A failed budget check does not block agent turns. Users without a
budget have no budget bar.

### Usage History

**Usage > Cost** and **Usage > Tokens** show the spend and tokens the gateway reports for your
user (`/user/daily/activity`), not local estimates. This includes other clients you send
through the same gateway. HYR Code does not read local transcripts from a LiteLLM instance's
home, so that spend is not counted twice. If a direct (non-LiteLLM) instance shares that home,
its history is skipped too.

- The gateway reports daily totals, so the hourly chart places each day's spend at 12:00 UTC.
- The gateway does not record which harness sent a request. Spend is attributed by model:
  Claude models to LiteLLM Claude, OpenAI models to LiteLLM Codex, and others to LiteLLM
  OpenCode.
- When you are signed out or the gateway cannot be reached, the source shows as failed in
  **Usage** and no LiteLLM spend is shown.

### Spend by Tag

**Usage > Cost** shows spend by request tag from the gateway's `/tag/daily/activity`, limited
to your keys. If the gateway refuses that request or reports no tag spend, HYR Code shows local
estimates at gateway rates for the tags it saved with each turn. The section says which source it
shows. Gateways that sign you in with OAuth (the `lite` SSO default) usually report no tag spend,
because they give each renewed sign-in a new key.

Use the type menu, the provider menu (estimates only), or search to narrow the rows. Use
**Hide tags** to remove tags you do not track, such as `tool:`; this browser remembers them.
The selected period and environments apply to this view. A request can have several tags, so
do not add the rows to get total spend.

## Request Tags

HYR Code sends [request tags](https://docs.litellm.ai/docs/proxy/request_tags) with LiteLLM
Claude, Codex, and OpenCode agent turns, so you can track spend by tag on the gateway. Titles,
commit messages, and other text generation do not carry tags.

- By default, each request carries the repository name, for example `repo:t3code`,
  `project:general-admin`, and the harness, for example `tool:T3-Code/claude`. To use your own text
  instead of the repository name, or to turn all three off, change **LiteLLM default request tag**
  in **Settings > Providers > Advanced**.
- To set tags for one thread, use **Tags** in the composer. Fill in **Jira ticket**, **Project**,
  **Environment**, or **Tool**, and HYR Code adds the category for you, for example
  `jira:PROJ-1234`. Use **Other tags** for your own categories, such as `team:platform`. Separate
  more than one value with commas. A tag can have 64 characters, with its category. Any tag
  replaces `project:general-admin`, and **Tool** replaces the harness tag. A change applies from the next message after the thread's background work ends.
  A change to the default tag applies the same way.
- Threads that a thread starts, such as delegated tasks, forks, and threads an agent creates,
  copy its tags. A scheduled task keeps the tags you set on it.

## Limits

- LiteLLM Codex uses its own config directory, so it does not read your usual Codex config or
  skills. A Codex provider you switch to LiteLLM might not resume threads it started before
  the switch.
- When the selected text generation model is not on the gateway, commit messages, titles,
  and branch names use the first gateway model.
- LiteLLM Codex does not accept `-c` or `--config` in **Launch arguments**, because Codex
  would then skip the gateway.
- LiteLLM OpenCode does not work with **Server URL**; HYR Code must start the OpenCode server.
- LiteLLM OpenCode does not send request tags if you set `OPENCODE_CONFIG`.
- A thread from before HYR Code 0.1.8 can share a LiteLLM Codex or OpenCode process with other
  threads. It keeps the tags that process started with until the process stops.
- The launcher is not available on Windows yet.
