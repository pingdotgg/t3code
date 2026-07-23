# Codex Workspace Skill Loading

Fix Codex repo-local skill discovery in the composer by resolving skills for the active project/worktree cwd, instead of relying on the global provider status snapshot.

Expected behavior:

- Repo-local Codex skills for the active workspace appear in the `$` skill picker.
- The server exposes a workspace-aware `server.listProviderSkills` path and validates enabled Codex skill-listing requests against the requested cwd.
- The server routes skill listing through a bounded request lister that coalesces concurrent requests for the same provider/cwd, limits cross-workspace concurrency, and applies a short TTL so reconnects or repeated composer renders do not repeatedly spawn Codex app-server probes.
- The Codex provider requests `skills/list` with the current workspace cwd, times out hung app-server probes, and terminates the probe process when a timeout occurs.
- Provider skill-list failures preserve structured reason, operation, provider instance, normalized cwd, and bounded cause diagnostics for missing providers, invalid cwd, settings failures, Codex home preparation, probe timeouts, and probe failures while keeping stable user-facing messages. Raw thrown values are not sent directly to clients; the server keeps a small plain diagnostic shape so file paths, process output, and unexpected objects do not expand the wire payload.
- Non-Codex or disabled providers keep returning provider snapshot skills instead of failing workspace skill search.
- The client runtime keys provider-skill query state by environment, provider instance, and cwd, with a bounded stale window so reconnects refresh workspace-local skills without reusing another workspace's snapshot. Client-side fallback skill changes do not refresh the workspace query or respawn Codex skill probes.
- Web workspace-skill lookup follows the route environment's connection state. While disconnected, it does not start an RPC, retains only verified skills for the same environment/provider/cwd across lazy menu close/reopen cycles, otherwise falls back to provider snapshot skills with a non-pending reconnect error, and resumes the workspace refresh when the environment reconnects.
- The composer loads workspace skills lazily: it starts workspace skill discovery when the `$` skill menu is active or the prompt already contains a complete `$skill` token, rather than probing on every empty composer mount. It preserves already loaded repo-local skills while refreshing the same workspace, falls back to provider snapshot skills when a settled workspace lookup returns no skills or errors, keeps structured lookup errors visible alongside those fallback skills on web and mobile, and clears stale repo-local skills during workspace switches or settled no-data states.
- The conversation timeline renders sent user prompts against the same workspace-aware skill list as the composer, so repo-local `$skill-name` references display with the same skill chip treatment as user-level skills. Timeline lookup stays disabled until a sent user prompt contains a complete skill token, including one at the end of the message, so an empty draft does not probe Codex merely to decorate nonexistent messages.
- The shared client-runtime policy also drives mobile thread composers and feeds. Mobile follows the selected environment's connection state, retains only verified same-workspace skills while disconnected or across lazy lookup close/reopen cycles, shows loading and structured reconnect/error feedback, refreshes an already-open `$` menu when skills arrive, decorates complete skill references, and prevents stale successful results from surviving failed refreshes or workspace switches.
- New-task drafts request workspace skills lazily only after a complete `$skill` reference. Local drafts resolve the selected checkout or project root, while future-worktree drafts deliberately have no cwd and use provider snapshots until the target directory exists.

Primary files:

- `apps/server/src/ws.ts`
- `apps/server/src/provider/ProviderSkillsLister.ts`
- `apps/server/src/provider/Layers/CodexProvider.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/chat/ChatComposer.tsx`
- `apps/web/src/components/chat/MessagesTimeline.tsx`
- `apps/web/src/lib/providerWorkspaceSkillsState.ts`
- `apps/mobile/src/state/providerWorkspaceSkillsState.ts`
- `apps/mobile/src/features/threads/new-task-provider-skills.ts`
- `apps/mobile/src/features/threads/thread-composer-skill-items.ts`
- `packages/client-runtime/src/state/providerWorkspaceSkills.ts`
- `packages/contracts/src/server.ts`
- `packages/client-runtime/src/state/server.ts`

Relevant tests live in:

- `apps/server/src/server.test.ts`
- `apps/server/src/provider/ProviderSkillsLister.test.ts`
- `apps/server/src/provider/Layers/CodexProvider.test.ts`
- `apps/server/src/provider/Layers/CursorProvider.test.ts`
- `apps/server/src/provider/Layers/GrokProvider.test.ts`
- `apps/web/src/components/chat/MessagesTimeline.test.tsx`
- `apps/web/src/lib/providerWorkspaceSkillsState.test.ts`
- `apps/mobile/src/features/threads/new-task-provider-skills.test.ts`
- `apps/mobile/src/features/threads/thread-composer-skill-items.test.ts`
- `packages/client-runtime/src/state/providerWorkspaceSkills.test.ts`
- `packages/client-runtime/src/state/runtime.test.ts`

Useful focused commands:

```sh
(cd apps/server && pnpm exec vp test run --passWithNoTests src/provider/ProviderSkillsLister.test.ts src/provider/Layers/CodexProvider.test.ts src/provider/Layers/CursorProvider.test.ts src/provider/Layers/GrokProvider.test.ts)
(cd apps/web && pnpm exec vp test run --passWithNoTests --project unit src/lib/providerWorkspaceSkillsState.test.ts)
(cd apps/mobile && pnpm exec vp test run --passWithNoTests src/features/threads/new-task-provider-skills.test.ts src/features/threads/thread-composer-skill-items.test.ts)
(cd packages/client-runtime && pnpm exec vp test run --passWithNoTests src/state/providerWorkspaceSkills.test.ts)
```

## Development Ports

- Web: `5735`
- Server/WebSocket: `13775`
