# Progress (radys-s fork)

## 2026-11-12: Auto model

- What: an "Auto" model with its own Low/Medium/High level. Picking it never reaches a provider; the server replaces it in every command (`OrchestratorV2.dispatch`) with a concrete model chosen from live usage limits: Fable (high), Opus (medium) or Sonnet (low) on whichever Claude account has more room, then Codex, Grok and OpenCode when Claude is out.
- Why: Tomáš wanted one Auto entry in the model picker that routes across all his subscriptions, including Claude A vs B.
- How it shows up: a custom model `auto` (with an `effort` select of low/medium/high) on the Auto Claude instances in settings. No web change was needed; the picker already renders custom models and their options.
- Numbers: resolver 5/5 tests; shared and server typecheck clean (server took 22 min on the first, cold run, ~6 min warm).
- Worked: one wrapper around `dispatch` covers web, mobile, MCP and scheduled tasks. Stickiness keeps a thread on its model until it passes 90% used, so threads do not hop accounts on each message.
- Next: after the first message the composer shows the concrete model, not "Auto"; keeping Auto selected mid-thread needs a client change.
