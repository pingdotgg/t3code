# Devin

This guide is for people who want to use Devin in T3 Code. For other providers, see
[Codex](./providers-codex.md) or [Claude](./providers-claude.md). For first-time setup, see
[Install T3 Code](./install.md).

T3 Code talks to Devin through its ACP (Agent Client Protocol) interface. It needs a Devin CLI that
exposes `devin acp` on standard input/output.

## I Only Use One Devin Account

Use the default provider.

In T3 Code Settings, your Devin provider can stay like this:

```text
Display name: Devin
Binary path: devin
Home path: empty
Launch arguments: empty
```

An empty `Home path` means T3 Code uses Devin's default home directory (`~/.devin` on macOS and
Linux, and the equivalent Windows user profile path). T3 Code sets this as `DEVIN_HOME` when it
spawns the Devin process.

## I Want Multiple Devin Accounts Or Presets

Use a different `Home path` for each provider instance. Each home keeps its own Devin sessions and
Usage transcripts, so T3 Code treats them as separate Devin environments.

Example:

```text
Display name: Devin Work
Binary path: devin
Home path: ~/.devin_work
```

```text
Display name: Devin Personal
Binary path: devin
Home path: ~/.devin_personal
```

T3 Code expands `~` in the `Home path`, resolves it to an absolute path, and sets
`DEVIN_HOME` before launching Devin. It does not create the directory; Devin CLI or the user
is responsible for ensuring it exists.

## Binary Path And The `devin-desktop` Fallback

`Binary path` is the command T3 Code runs to start Devin ACP. If you leave it empty, T3 Code tries
`devin` first and then falls back to `devin-desktop` automatically if `devin` is not on `PATH`.

Some installations expose the CLI as `devin-desktop` while still speaking ACP. T3 Code will use it
the same way, launching it as `devin-desktop acp` with the configured `Launch arguments`.

If your Devin binary is in a non-standard location, set the full path:

```text
Binary path: /opt/devin/bin/devin
```

## Launch Arguments

`Launch arguments` are extra arguments passed to the Devin CLI after the `acp` subcommand. They are
tokenized the same way as a shell command, so quoted arguments are supported.

Example:

```text
Launch arguments: --verbose --log-level debug
```

This produces a command like:

```text
devin acp --verbose --log-level debug
```

Do not put environment variable assignments in `Launch arguments`. Use the provider's
**Environment variables** section for those, and mark tokens or API keys as sensitive.

## Authentication

Devin's CLI authentication is handled by Devin itself, not by T3 Code. Run the login command that the
Devin CLI documentation recommends before you start a session, then confirm the provider status in
T3 Code Settings.

If Devin uses an API key or base URL that needs to be per-provider, add those variables to the
provider's **Environment variables** section and mark the values as sensitive. T3 Code stores
sensitive values as server secrets and does not send them back to the app after saving.

## Token Usage And Cost

Devin token usage is reported in real time during a conversation and aggregated in **Usage**.

- Real-time usage appears from Devin's ACP prompt responses.
- Aggregated usage is written to `<home path>/t3code-usage.jsonl` and scanned by the Usage page.
- Cost is estimated from LiteLLM rate data when Devin does not report a cost itself. Unpriced Devin
  models appear as `unpriced` rather than inventing a rate.

## Can I Switch Models In An Existing Thread?

Yes, when the Devin session advertises the requested model. T3 Code sends a `session/set_config_option`
ACP request for the model config option when the model picker changes. If Devin rejects the model,
the request fails with the provider error shown in the UI.

## Can I Switch Accounts In An Existing Thread?

No. Devin sessions are tied to the `Home path` they were created with. A different home is treated
as a different Devin environment, so existing threads cannot be moved to another Devin provider.
