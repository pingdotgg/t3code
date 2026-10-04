# T3 Mobile

This fork ships an Android interface and its own Termux backend. Only the mobile
presentation is retained from T3 Code; do not reintroduce T3's server, client runtime,
web, desktop, relay, authentication or provider SDKs.

## Working rules

- Backend: `apps/runtime`, Node 22.18+, TypeScript executed by Node, `ws` only.
- Shared mobile/backend interface: `packages/protocol`.
- UI: `apps/mobile`, Expo/React Native, retained T3 components and theme tokens.
- Keep credentials in Termux; the mobile pairing credential goes in SecureStore.
- Bind the backend to loopback. Spawn CLIs with argument arrays, never shell strings.
- Do not write to `~/.t3/userdata` or any other existing application's state.
- Never kill processes by pattern. Stop only processes started and tracked by this task.
- Run targeted checks. Backend behavior changes need tests through the public
  mobile interface, using a fake external Codex process where appropriate.
- Do not launch browsers/computer-use without user authorization.
- Do not create PRs unless asked. Do not commit research notes or scratch plans.
- Preserve upstream licenses and Android terminal attribution.

## Matt Pocock's skills

The user requested these skills for the workflow. Installed files live in
`.agents/skills`; source revisions are in `skills-lock.json`. Read the applicable
skill before using it. Use module-design guidance, agreed TDD interfaces and the
implementation skill's final code review. Repository checks stay scoped to mobile
and runtime, rather than the deleted upstream monorepo.

Configured tracker, labels, domain layout, and agreed test scope are linked from
`CLAUDE.md` and recorded in `docs/agents/`. Read those files before using a skill
that depends on repository configuration.
