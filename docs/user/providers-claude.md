# Claude

T3 Code uses Claude Code's login and configuration. Start with the default provider
for one account; [provider setup](./install.md#providers) covers installation and
shared provider settings.

## Separate accounts or configurations

Use a separate Claude config directory for each account. This also works for named
presets that need different Claude settings or a router connection.

Keep your existing account in the default directory. On the environment's machine,
create the second login:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add another Claude instance in **Settings > Providers**:

| Instance        | Binary path | CLAUDE_CONFIG_DIR path |
| --------------- | ----------- | ---------------------- |
| Claude Work     | `claude`    | Leave empty            |
| Claude Personal | `claude`    | `~/.claude_personal`   |

An empty config-directory setting uses Claude Code's normal configuration. The
custom setting changes `CLAUDE_CONFIG_DIR`, leaving `HOME` and the system keychain
location intact. Use the same variable for the login command. Setting `HOME`
instead can put credentials where this provider will not find them.

Check the account reported in provider settings after signing in. Existing
threads can switch only between Claude instances with the same config directory.
Separate account directories stay isolated, including their local conversation
state. Claude does not have Codex's shared-home and shadow-home arrangement.

For presets that differ only in API keys or endpoints, use the instance's
**Environment variables**. Variable assignments do not belong in **Launch arguments**.

Claude Code's verbose mode can stay enabled when you use Claude for text generation, including
thread titles, branch names, commit messages, and pull request descriptions. On a remote connection,
T3 Code uses the Claude configuration on the connected server.

## Compact long conversations

Set **Auto-compact after** in the Claude provider settings to an integer between
`100000` and `1000000`. For example, `300000` asks Claude to summarize at about
300,000 tokens. This changes when compaction happens, not the model's context
window. Leave it empty for Claude Code's default.

You can also send `/compact` in an existing conversation. Web and desktop offer
**Compact context** from the context meter and may suggest it when you return to
a large older thread. See [commands and skills](./composer.md#commands-and-skills)
for using composer commands.

### Custom models behind a router

A router's model may support more context than Claude Code recognizes from its
name. First add your custom non-Claude model in **Settings > Providers** for the
Claude instance that connects to your router.

On that environment's machine, open `~/.t3/userdata/settings.json`. If the server
uses a custom data directory through `T3CODE_HOME` or `--base-dir`, open
`userdata/settings.json` inside that directory instead. For a remote environment,
edit the file on the server, rather than on the device running the client.

Find your Claude instance under `providerInstances`, then its
`config.customModels` array. Add `contextWindowTokens` to the matching model entry
as shown below, keeping the other settings and model entries. If your model is
stored as a string, replace that string with an object using the same ID as
`slug`. The value must be an integer from `8192` to `1000000`:

```json
{
  "slug": "my-router-model",
  "name": "My router model",
  "contextWindowTokens": 872000
}
```

Save the file while that Claude instance is idle: changing its settings replaces
the instance and interrupts any turn running on it. A non-integer or out-of-range
allowance makes the instance unavailable until you correct the value.

After saving, select that custom model and send a message. T3 reloads the settings
and applies the allowance when it starts the model's next turn. The model editor
preserves the allowance when you change the model's name or options; the allowance
itself is configured in the settings file. Saving model edits from an older
client also preserves the saved allowance for the same model ID. To remove the
allowance, delete `contextWindowTokens` from that entry in the settings file.

Use a limit verified for your router, account, and model. The number above is an
example, not a default or a guarantee of provider capacity. Leave the field absent
to use Claude Code's normal model handling. Built-in Claude models retain their
own context settings. A custom entry that reuses a built-in catalog slug is
ignored. Claude Code controls capacity for Claude identifiers, including
provider-prefixed IDs such as `anthropic/claude-opus-4-8`, native aliases
such as `default`, `best`, `fable`, `opus`, `sonnet`, `haiku`, and `opusplan`, and
model IDs containing `[1m]` anywhere, in any casing.
T3 reports an error if a custom allowance is selected for those identifiers.

T3 applies the custom allowance whenever it starts the selected model, including
after switching models within the same Claude provider. It keeps automatic
compaction enabled and honors your separate **Auto-compact after** setting. If
Claude Code cannot start the selected model with that allowance, the switch
reports an error instead of continuing with an incorrect limit.

The context meter uses the selected model's declared allowance. Custom models
without an allowance retain the existing 200,000-token fallback. Switching back
to one of those models clears the custom allowance and restores that fallback.

## Usage limits

If your Claude subscription runs out of usage mid-turn, the thread shows which
limit was reached and the remaining wait when Claude provides a reset time.
Claude Code holds the turn until that window reopens, so it can keep showing as
working. Wait for the reset, or stop the turn and continue later. The warning's
timestamp shows when the displayed wait started.

## Skills

Claude skills come from the config directory's `skills` folder and the project's
`.claude/skills` folder. If both define the same name, the config-directory copy
wins. Skills disabled in Claude's settings do not appear in the composer.

Use `$` in the composer to select a skill. Skills marked `disable-model-invocation`
can still be started by you. Invoke those one per message: Claude directly runs
only the last named skill and may try to start earlier ones through its Skill
tool, which refuses skills reserved for manual invocation.

## OpenRouter

Create a Claude instance with its own config directory, such as
`~/.claude_openrouter`, and keep **Binary path** set to `claude`. In that instance's
**Environment variables**, use:

| Variable               | Value                                     |
| ---------------------- | ----------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`               |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key, marked Sensitive |
| `ANTHROPIC_API_KEY`    | An explicitly empty value                 |

If that Claude config directory has a cached Anthropic login, run `/logout` in a
Claude Code session using that directory before starting the router setup. Cached
login credentials can conflict with the router token.

Select the model you want in T3 Code. For an OpenRouter model outside the built-in
list, open that Claude instance in **Settings > Providers** and add its full model
ID with **Add custom model**. Then select it in the chat model picker.
`ANTHROPIC_DEFAULT_*_MODEL` variables map Claude Code aliases such as `sonnet`; they
do not replace the explicit model ID selected in T3 Code. Custom models may have
fewer effort, thinking, or context controls than built-in models.

Verify the model used in OpenRouter's activity dashboard. For current compatibility
requirements, use the
[OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).

## Other routers

A local router uses an ordinary Claude provider instance. Give it a separate
config directory and put the router's endpoint and credential variables in that
instance's **Environment variables**. The router must run where the environment
can reach it. Follow the [Claude Code Router instructions](https://github.com/musistudio/claude-code-router)
for its installation and routing configuration.
