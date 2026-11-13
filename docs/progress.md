# Progress (radys-s fork)

## 2026-11-12: Auto model

- What: an "Auto" model with its own Low/Medium/High level. Picking it never reaches a provider; the server replaces it in every command (`OrchestratorV2.dispatch`) with a concrete model chosen from live usage limits: Fable (high), Opus (medium) or Sonnet (low) on whichever Claude account has more room, then Codex, Grok and OpenCode when Claude is out.
- Why: Tomáš wanted one Auto entry in the model picker that routes across all his subscriptions, including Claude A vs B.
- How it shows up: a custom model `auto` (with an `effort` select of low/medium/high) on the Auto Claude instances in settings. No web change was needed; the picker already renders custom models and their options.
- Numbers: resolver 5/5 tests; shared and server typecheck clean (server took 22 min on the first, cold run, ~6 min warm).
- Worked: one wrapper around `dispatch` covers web, mobile, MCP and scheduled tasks. Stickiness keeps a thread on its model until it passes 90% used, so threads do not hop accounts on each message.
- Next: after the first message the composer shows the concrete model, not "Auto"; keeping Auto selected mid-thread needs a client change.

## 2026-11-13 — Auto gets its own icon in the model picker

- What: the `auto` model shows a Route icon in the theme's primary color (picker rows and the composer button) instead of the Claude logo, and drops the account badge, since Auto picks the account itself.
- Why: Tomáš could not tell Auto apart from the concrete Claude models at a glance.
- How: `ProviderInstanceIcon` takes an optional `modelSlug`; `ModelListRow` and `ProviderModelPicker` pass it. Lint rules ruled out Sparkles and raw palette colors.
- Deploy: web-only, so the new `apps/web/dist` was copied into `apps/server/dist/client`; no service restart. The web build took ~45 min on the hub (disk-bound).
- Next: keep "Auto" shown in the composer after the first message (needs the thread to remember the Auto selection).
