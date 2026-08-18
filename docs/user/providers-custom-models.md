# Custom models

Add a model in **Settings → Providers → your provider → Models**. Use the settings button beside the
custom model to add any select or on/off control by its exact option ID. Set its label, values, and
default. The message composer then shows the declared controls.

T3 Code keeps the saved model ID exact. A provider adapter can change request syntax only when its
native API requires it. Existing custom models with no capability metadata keep their old behavior.

## Adapter behavior

| Provider | Control IDs with runtime translation                    |
| -------- | ------------------------------------------------------- |
| Claude   | `effort`, `fastMode`, `contextWindow`, `thinking`       |
| Codex    | `reasoningEffort`, `serviceTier`                        |
| Cursor   | `reasoning`, `contextWindow`, `fastMode`, `thinking`    |
| OpenCode | `variant`, `agent`                                      |
| Grok     | None; T3 Code's Grok adapter sends only model selection |

The capability editor and composer render every declared select or on/off descriptor without a
provider control list. This does not add a new provider API option. An adapter sends IDs it
understands and ignores other selections.

Cursor sends choices through ACP session configuration. A choice is applied only when the active
Cursor CLI reports a matching configuration option for the selected model.

OpenCode sends `variant` and `agent` through its SDK request. Its adapter has no model speed-tier or
context-window request option. The Grok adapter sends only model selection, so custom controls can be
displayed but do not change its request.

Claude `fastMode` is a Claude Code setting. It is not OpenAI priority service. Codex sends speed as
its native `serviceTier` value. Do not use one as a substitute for the other.

For Claude only, selecting a declared `1m` context value adds Claude Code's `[1m]` model selector at
launch. The saved and displayed custom model ID stays unchanged. T3 Code does not assume 1M support
for any model that did not declare it.
