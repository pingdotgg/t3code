# Pi Slash Command And Model Parity

Date: 2026-05-27
Branch: `codex/pi-provider`

This document records the implemented Pi model and slash-command behavior for the
T3 provider integration.

## Model List Behavior Target

- Use existing Pi config from `~/.pi/agent` by default.
- Prefer live Pi RPC `get_available_models` for available model options.
- Use local Pi `settings.json` only for default and enabled-model ordering.
- Show the configured default model first when available.
- Show configured/frequently used models before all remaining models when available.
- Visual separator row is currently blocked by T3's `ServerProviderModel` contract unless a UI/schema change is added.

## Slash Command Sources

Pi built-in interactive slash commands observed from source:

- `/settings`
- `/model`
- `/scoped-models`
- `/export`
- `/import`
- `/share`
- `/copy`
- `/name`
- `/session`
- `/changelog`
- `/hotkeys`
- `/fork`
- `/clone`
- `/tree`
- `/login`
- `/logout`
- `/new`
- `/compact`
- `/resume`
- `/reload`
- `/quit`

Pi RPC dynamic command source:

- `get_commands` returns extension commands, prompt templates, and skills.

## Implementation Status

Implemented as a provider snapshot plus best-effort pass-through behavior:

- T3 discovers the Pi executable, then runs Pi RPC probes against the existing
  local Pi config/auth state.
- T3 reads `~/.pi/agent/settings.json` for default and enabled-model ordering.
- T3 does not create a separate T3-only Pi config and does not set
  `PI_CODING_AGENT_DIR`.
- Pi model options are populated from live Pi RPC `get_available_models`.
- Pi slash commands are populated from a built-in command list plus dynamic Pi
  RPC `get_commands`.
- Slash command execution is not implemented as native T3 control actions.
  Commands inserted/sent as chat text are passed to Pi through the prompt path,
  which is the broadest feasible compatibility layer without embedding the Pi
  interactive TUI.

Verified snapshot on 2026-05-27:

- Pi executable: `/opt/homebrew/bin/pi`
- Pi version: `0.75.5`
- Pi config root used by Pi: `/Users/ambrealismwork/.pi/agent`
- T3 provider status: `ready`
- Pi model count: 63
- Pi slash command count: 71
- First ordered models:
  - `openai-codex/gpt-5.5`
  - `anthropic/claude-opus-4-6`
  - `anthropic/claude-sonnet-4-6`
  - `anthropic/claude-haiku-4-5`
  - `openai-codex/gpt-5.2`
  - `openai-codex/gpt-5.3-codex`
  - `openai-codex/gpt-5.3-codex-spark`
  - `openai-codex/gpt-5.4`

Visual separator status:

- Preferred/default/enabled models are ordered first.
- A literal separator row is not implemented because the current
  `ServerProviderModel` contract represents selectable models only and has no
  non-selectable separator item shape.

## Verified Commands

- Built-in command names are exposed in the provider snapshot:
  `/settings`, `/model`, `/scoped-models`, `/export`, `/import`, `/share`,
  `/copy`, `/name`, `/session`, `/changelog`, `/hotkeys`, `/fork`, `/clone`,
  `/tree`, `/login`, `/logout`, `/new`, `/compact`, `/resume`, `/reload`,
  `/quit`.
- Dynamic command names from Pi RPC `get_commands` are exposed in the provider
  snapshot, including extension and skill commands observed locally.
- T3 prompt delivery through Pi was verified with the model
  `openai-codex/gpt-5.5`; the response contained the exact expected text
  `T3 Pi provider verification OK`.

## Partial Commands

- `/model`: native model choice is handled by T3's model selector and passed to
  Pi as `--model`; textual `/model` input is passed through as prompt text.
- `/new`: native new-chat behavior is handled by T3 thread creation; textual
  `/new` input is passed through as prompt text.
- `/compact`: Pi has RPC command support for compaction, but this integration
  does not wire it as a special T3 control action yet. Textual `/compact` input
  is passed through as prompt text.
- `/fork` and `/clone`: Pi has RPC command definitions, but exact behavior needs
  Pi-specific entry-id/session context that T3 does not currently expose as a
  first-class slash-command UI parameter.
- `/name` and `/session`: T3 has its own thread title/session state. Exact Pi TUI
  session mutation is not mapped to those T3 controls yet.
- Extension, prompt-template, and skill slash commands are exposed from
  `get_commands` and can be passed to Pi as text, but exact parity depends on
  how each Pi command expands inside Pi's prompt path.

## Blocked Commands

- Exact interactive TUI parity is blocked for commands whose primary behavior is
  opening Pi UI panels or manipulating the Pi TUI process:
  `/settings`, `/scoped-models`, `/export`, `/import`, `/share`, `/copy`,
  `/session`, `/changelog`, `/hotkeys`, `/tree`, `/login`, `/logout`,
  `/resume`, `/reload`, `/quit`.
- These commands are still visible as Pi-supported names where appropriate, but
  T3 cannot reproduce their full interactive behavior without either embedding
  Pi's TUI or adding dedicated T3 UI/control surfaces for each command.
