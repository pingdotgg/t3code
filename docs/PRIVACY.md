# Privacy notice

Continuum IDE runs on your computer. This notice covers the Continuum IDE desktop app and server
built from this repository.

## What stays on your computer

Projects, conversations, settings, checkpoints, terminal sessions, and logs are stored locally in
`~/.continuum` and are never uploaded by Continuum.

## What Continuum sends

- **Product analytics: none by default.** Continuum ships with analytics disabled and with no
  analytics endpoint configured. An operator can opt in by setting `T3CODE_TELEMETRY_ENABLED=true`
  together with their own `T3CODE_POSTHOG_KEY` and `T3CODE_POSTHOG_HOST`.
- **Update checks:** the desktop app asks GitHub for this repository's latest release.
- **Your AI agents:** prompts and code go to the AI provider you choose (Anthropic, OpenAI, Google,
  and others) through that provider's own agent, under that provider's terms.
- **Optional services you turn on:** T3 Connect (a relay operated by T3 Tools Inc.), Tailscale, SSH
  hosts, and Git hosting accounts receive what those features need.

## Credentials

Provider sign-ins stay in each agent's own credential storage. Secrets can come from a password
manager by reference instead of being saved in Continuum, and agents request secrets in a private
card rather than in the conversation.

Questions: [open an issue](https://github.com/SwashX-dev/continuum-ide/issues).
