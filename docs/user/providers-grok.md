# Grok

T3 Code connects to Grok through the Grok CLI's ACP session. Optional controls are shown only when
that CLI advertises the corresponding capability during session setup.

## Plan mode

The Plan/Build toggle is available when the installed Grok CLI exposes a native plan mode and a
separate build/default mode. T3 applies the selected mode to the ACP session before sending the
turn; it does not add instructions to your prompt.

If the toggle is missing, the CLI did not negotiate a usable native mode pair. Normal prompts and
existing Grok plan updates continue to work.

## Reasoning controls

When Grok advertises reasoning choices—either as an ACP configuration option or as the model's
native reasoning-effort metadata—T3 shows those choices in the model controls. The choices and
values come from Grok, so they can differ between models and CLI versions. A custom model has no
reasoning control unless Grok negotiates one for that session.

## Context window

Grok ACP usage updates populate T3's existing context-window dial when the CLI reports both the
current usage and a positive context size. Missing values are left unavailable rather than
estimated.

## Subagents and background work

T3 does not guess Grok child-task relationships. Native subagents or background work appear in T3's
Agents and background state only after a Grok CLI version provides explicit child identity,
parentage, task type, and lifecycle notifications that ACP can verify. Older or partially capable
CLIs keep those notifications isolated from the root conversation and continue supporting ordinary
Grok turns.

Some current Grok CLI releases expose reasoning metadata without exposing a native ACP Plan/Build
mode pair or child-task lifecycle. In that case T3 keeps Plan and native-agent UI unavailable while
normal Grok prompts continue to work.
