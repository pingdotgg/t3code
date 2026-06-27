# T3work Additive Whitelist Draft

This whitelist supports the additive guard in `.t3work-additive-guard.json`.

Guard runner: `t3work-additive-guard.mjs`

Prefix policy:

- New additive files may use either `t3work-` or `t3work.` prefixes.
- Route files use dot-separated TanStack route names and are valid additive files.

## Allowed Modified Upstream Files

- `AGENTS.md`
  - Update project constitution reference from project-shell to t3work docs.
- `package.json`
  - Add `lint:t3work:additive` guard script entry.
- `apps/server/package.json`
  - Add `t3work` bin and `dev:t3work` / `start:t3work` scripts.
- `apps/server/src/server.ts`
  - Mount `/api/t3work/atlassian/*` routes in the main server so migrated `/t3work` UI sign-in does not 404.
- `apps/server/src/server.test.ts`
  - Provide the live `VcsProcess` layer in the server router seam test so repo-wide typecheck remains green after the shared VCS service split.
- `apps/server/tsdown.config.ts`
  - Bundle `src/t3work-bin.ts` alongside existing server bin.
- `apps/web/package.json`
  - Add migrated t3work dependencies used by the main app route.
- `apps/desktop/scripts/electron-launcher.mjs`
  - Use `ditto` on macOS when copying the Electron app bundle so dev launcher rebuilds preserve bundle symlinks and avoid locale copy failures.
- `apps/desktop/scripts/dev-electron.mjs`
  - Serialize desktop Electron dev supervision with a PID lock, orphan cleanup, and Vite readiness checks so restarts do not race stale processes or an unavailable dev server.
- `apps/web/vite.config.ts`
  - Add dev proxy/defaults and compile-time constants used by migrated t3work route.
- `apps/web/src/routeTree.gen.ts`
  - Generated TanStack route tree update after adding `/t3work` route.
- `apps/web/src/routes/__root.tsx`
  - Register global t3work route shell entrypoint in root routing tree.
- `apps/web/src/components/settings/SettingsPanels.tsx`
  - Keep a minimal insertion seam (`<T3workWorkModeSetting />`) so custom mode UI lives in prefixed files while preserving upstream settings updates.
- `apps/web/src/components/ChatView.tsx`
  - Add `composerContextAttachmentSlot?: ReactNode` prop to both union variants, read context attachments from store in `onSend`, and render the slot above ChatComposer. Minimal upstreamable seam enabling t3work attachment chip injection.
- `apps/web/src/components/chat/MessagesTimeline.tsx`
  - Parse and render context attachment chips from user message text, then strip the inline attachment block from message body rendering so timeline displays clean content.
- `apps/web/src/composerDraftStore.ts`
  - Add optional `contextAttachments?: ComposerContextAttachment[]` field + 3 CRUD methods (`addContextAttachment`, `removeContextAttachment`, `clearContextAttachments`) to per-thread draft state. Generic, upstreamable extension point for ephemeral context attachments.
- `apps/server/src/provider/Layers/CodexSessionRuntime.ts`
  - Bind the in-process t3work tool broker into Codex session startup so dynamic tool registration and MCP-backed view/thread actions work per thread without introducing a second provider stack.
- `apps/server/src/provider/Layers/CodexSessionRuntime.test.ts`
  - Cover the Codex runtime's dynamic-tool thread-start payload and MCP binding behavior alongside the owning upstream runtime file.
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
  - Preserve optional `t3workExt` on thread message upserts inside the existing projection pipeline so system-message metadata survives projection updates.
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
  - Decode and return optional `t3workExt` from projection-thread message rows so the additive message seam is readable from snapshots.
- `apps/server/src/orchestration/decider.ts`
  - Add the minimal `thread.message.upsert` command-to-event seam needed to persist first-class system messages without forking the orchestration model.
- `apps/server/src/orchestration/projector.ts`
  - Project optional `t3workExt` through thread message sent/update events so the read model keeps workflow message metadata.
- `apps/server/src/persistence/Layers/ProjectionThreadMessages.ts`
  - Persist optional `t3workExt` JSON alongside existing projection-thread message fields as the smallest storage seam for workflow message metadata.
- `apps/server/src/persistence/Migrations.ts`
  - Register the additive t3work migration that adds `projection_thread_messages.t3work_ext_json`.
- `apps/server/src/persistence/Services/ProjectionThreadMessages.ts`
  - Extend the projection-thread message schema with optional `t3workExt` so the persistence layer can carry the namespaced message extension.
- `packages/contracts/src/settings.ts`
  - Add optional `t3workStoredProjectsJson` / `t3workStoredSidebarPinsJson` / `t3workStoredSidecarCompositionJson` client-setting keys so desktop-stable t3work project, sidebar-pin, and sidecar-composition persistence can reuse the existing local client-settings seam without widening unrelated runtime APIs.
- `apps/web/src/store.ts`
  - Thread optional `t3workExt` through the existing chat-message mapper so user-visible timeline filtering/rendering can read the additive message seam.
- `apps/web/src/types.ts`
  - Add optional `t3workExt` to the web chat-message type as the minimal client-side seam for workflow system message metadata.
- `packages/contracts/src/index.ts`
  - Export the additive `t3work-message-ext` contract from the shared contracts entrypoint so upstream seams can import the namespaced extension type.
- `packages/contracts/src/orchestration.ts`
  - Add optional `t3workExt` and `thread.message.upsert` to the orchestration contract so first-class system messages flow through the existing command/event channel.
- `packages/project-context/src/index.ts`
  - Export additive action-recipe context helpers from the shared package entrypoint so runtime and UI code can share one canonical launch-context schema.
- `bun.lock`
  - Lockfile drift due workspace/package updates.

## Rules

- Keep this list minimal.
- Any new entry requires a one-line reason in this document.
- Any changed file listed in `allowedModifiedFiles` must auto-merge cleanly against `baseRef` (`upstream/main` by default). If auto-merge is not possible, additive guard fails and prints a diff; user/agent must manually merge.
- Prefer additive `t3work-*` or `t3work.*` files over editing upstream files.
- Additive `.test`, `.browser`, `.stories`, and `*Fixtures` files use a higher LOC ceiling because they are validation/demo artifacts rather than shipped runtime surfaces.
- Remove entries when no longer needed.
