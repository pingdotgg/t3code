# Kimi Model Discovery and Thinking Controls Design

## Summary

Fix Kimi's empty default model picker by discovering models from the generic ACP `model`
configuration option used by Kimi Code CLI 0.29.1 and newer. Preserve the legacy ACP `models`
response path, then probe each discovered model through ACP to capture its model-specific thinking
choices.

Kimi's official `K2.7 Coding Highspeed` entry remains a distinct model. T3 does not invent a
provider option that the CLI cannot apply.

## Problem

T3 currently reads `session/new.models.availableModels`. Kimi Code CLI 0.29.1 omits that legacy
field and instead returns these entries in a `configOptions` select with `category: "model"`:

- `kimi-code/kimi-for-coding` — K2.7 Coding
- `kimi-code/kimi-for-coding-highspeed` — K2.7 Coding Highspeed
- `kimi-code/k3` — K3
- `kimi-code/k3-256k` — K3-256k

Because the provider snapshot sees no models, T3 cannot switch models and never probes the
model-specific configuration returned after a switch. K3's `Low`, `High`, and `Max` thinking levels
therefore also remain hidden.

## Goals

- Populate the Kimi model picker from the installed CLI and authenticated account.
- Mark the model config option's `currentValue` as the default model.
- Show K2.7 Highspeed as the official speed-oriented model.
- Show the thinking values each model advertises after an ACP model switch.
- Preserve support for older Kimi ACP versions that return the legacy `models` object.
- Avoid contract, web, mobile, and orchestration changes.

## Non-goals

- Hard-code a model catalog in T3.
- Add a synthetic `fastMode` or `speed` option.
- Expose thinking values not accepted by the active CLI.
- Change Kimi's Early Access status or unrelated adapter behavior.

## Provider Adapter Decisions

| Provider | Decision               | Reason                                                                                 |
| -------- | ---------------------- | -------------------------------------------------------------------------------------- |
| Kimi     | Update model discovery | Kimi Code CLI 0.29.1 advertises its catalog through an ACP model config option.        |
| Codex    | Unchanged              | Codex uses its own app-server model discovery and does not consume Kimi ACP responses. |
| Claude   | Unchanged              | Claude uses its SDK adapter and provider-specific option mapping.                      |
| Cursor   | Unchanged              | Cursor's ACP model behavior is independent of Kimi's response shape.                   |
| Grok     | Unchanged              | Grok retains its existing ACP model-state implementation.                              |
| OpenCode | Unchanged              | OpenCode uses its own provider API and model discovery path.                           |

No provider is marked unsupported: this is a compatibility fix for Kimi's provider boundary, and
the other five adapters continue using their existing supported paths.

## Design

### Normalize ACP model discovery at the provider boundary

`KimiProvider` will derive a single internal model discovery result from the session setup response:

1. Find the select config option whose category is `model`.
2. When it contains valid values, use it as the authoritative current model and model catalog.
3. Otherwise, fall back to `models.currentModelId` and `models.availableModels` from older ACP
   implementations.
4. Convert config-option values to ACP-shaped model entries, using the option value as the model ID
   and its name as the display name.
5. Ignore blank and duplicate IDs while retaining source order.

This keeps the rest of provider snapshot construction unchanged and makes compatibility explicit in
one helper.

### Probe model-specific thinking controls

The existing bounded discovery session will switch through every normalized model, read the updated
config options, and restore the original model. Generic option conversion will continue to exclude
the `model` and `mode` selectors themselves while retaining Kimi's `thinking` selector.

For the current managed catalog this yields:

- K2.7 Coding and K2.7 Coding Highspeed: `Thinking = On`, because they are always-thinking models.
- K3 and K3-256k: `Thinking = Low | High | Max`, with `High` selected by default.

The adapter already applies the selected model before provider options and routes both through
`session/set_config_option`, so no session execution change is required.

### Failure behavior

If no valid model source exists, Kimi continues to fall back to user-configured custom models and
the existing provider status behavior. If one model's option probe fails, that model remains visible
with empty capabilities while discovery continues. Model restoration remains best-effort inside the
throwaway probe session.

## Surface Coverage

The server provider snapshot is shared by web, desktop, and mobile. Existing generic model and
provider-option controls render the normalized models and thinking selector on all clients, so no
client-specific branch is needed. Local, relay, and tunnel connections keep the same server-side
Kimi process behavior.

## Testing

Extend the focused Kimi provider fixture to match Kimi Code CLI 0.29.1:

- `session/new` contains model, thinking, and mode config options but no legacy `models` field.
- Discovery returns all four model IDs in source order.
- The current K2.7 model is marked as default.
- Switching to K3 returns `Low`, `High`, and `Max`, with `High` as the current/default value.
- The Highspeed model remains a normal model entry, not a synthetic option.
- A separate compatibility assertion keeps the legacy `models` path working.
- Blank and duplicate config-option model values are ignored.

Run the focused Kimi provider tests and the server typecheck. The optional real-CLI ACP probe may be
run because it creates a throwaway session without sending a billable prompt.

## Upstream Evidence

- Kimi Code CLI 0.29.1 live ACP `session/new` response on Windows, inspected without a prompt.
- Kimi Code CLI `provider list --json`, which reports the same four managed model aliases.
- Kimi ACP model switching, which advertises and accepts K3 thinking values `low`, `high`, and `max`.
- Official Kimi provider and model documentation:
  <https://moonshotai.github.io/kimi-code/en/configuration/providers.html>
