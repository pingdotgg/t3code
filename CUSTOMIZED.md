# Custom Branch Changes

## Debug Browser Launch

For web/server debug work in this branch, start the backend with browser auto-open disabled, then if needed navigate the intended active browser window manually or through Playwright MCP:

```sh
T3CODE_NO_BROWSER=1 pnpm exec node scripts/dev-runner.ts --dev-url http://127.0.0.1:5173 dev:server
```

If a pairing URL is required, open the printed `/pair#token=...` URL in the already-open browser window being used for the debug session.

## Installable Build Commands

Use these commands from the repository root when producing local installable artifacts for this customized branch.

### VS Code Extension

Build a local VSIX and install the newest generated package into VS Code:

```sh
pnpm --filter t3code-vscode package
code --install-extension "$(ls -t apps/vscode-extension/*.vsix | head -1)"
```

### Desktop App

Build a macOS arm64 DMG using the same desktop artifact path used for this branch:

```sh
pnpm run dist:desktop:dmg:arm64
open "$(ls -t release/T3-Code-*-arm64.dmg | head -1)"
```

### Mobile App

Build the installable Android preview APK locally, avoiding the EAS cloud worker queue, then install it directly over USB:

```sh
cd apps/mobile
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=/opt/homebrew/share/android-commandlinetools ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools PATH="/opt/homebrew/opt/openjdk@17/bin:/opt/homebrew/share/android-commandlinetools/platform-tools:$PATH" EAS_SKIP_AUTO_FINGERPRINT=1 EAS_BUILD_DISABLE_EXPO_DOCTOR_STEP=1 pnpm dlx eas-cli@latest build --profile preview -p android --local --output ./build/android/t3-code-preview.apk
adb install -r ./build/android/t3-code-preview.apk
```

Upload the local APK to EAS when a shareable install link is needed:

```sh
cd apps/mobile
pnpm dlx eas-cli@latest upload -p android --build-path ./build/android/t3-code-preview.apk --non-interactive
```

This branch carries local conversation-rendering changes that are not assumed to exist upstream. Keep this file current when changing local behavior so future merges can preserve the intended UX, and so these patches can be removed when upstream covers the same behavior.

## Conversation Tool Activity Rendering

The custom behavior is focused on making subagent and tool activity easier to read in long-running Codex threads without changing agent execution semantics.

### File Change And Command Activity Boxes

File-change and command activities are rendered as clickable, expandable rows in the conversation work log.

Expected behavior:

- A file-change row keeps the compact `Changed files - path/to/file` style preview while collapsed.
- Clicking a file-change row expands it inline and renders any available patch with the same `FileDiff` diff viewer used by other conversation diff surfaces.
- If a file-change event only has paths and no patch, the expanded row still lists the changed paths instead of opening the full turn diff panel.
- A command row keeps the compact `Ran command - command` style preview while collapsed.
- Clicking a command row expands it inline and shows the command, raw command when it differs, stdout, stderr, exit code, and duration.
- Stdout and stderr show only the last 40 lines by default when longer than 40 lines; clicking either output block toggles the full stream.

Primary files:

- `apps/web/src/session-logic.ts`
- `apps/web/src/components/chat/MessagesTimeline.tsx`

### Subagent Activity Boxes

Subagent activity is rendered as a collapsible tool-style row instead of letting child-agent text stream directly into the main conversation timeline.

Expected behavior:

- A subagent should appear as a single logical `Subagent` activity for the parent collab tool call.
- While the subagent is running, the UI may show the parent prompt/title as the activity preview.
- When expanded, the box shows `Prompt` and `Output` sections.
- If prompt and output are identical, or one starts with the other, only the output is shown.
- Empty placeholder subagent lifecycle rows are omitted, so a single subagent should not render as repeated blank `Subagent` rows around prompt/output rows.
- Child subagent output should not be rendered as a normal assistant message in the main conversation.

Primary files:

- `apps/server/src/provider/Layers/CodexSessionRuntime.ts`
- `apps/server/src/provider/Layers/CodexAdapter.ts`
- `apps/web/src/session-logic.ts`
- `apps/web/src/components/chat/MessagesTimeline.tsx`
- `apps/web/src/environments/runtime/service.ts`
- `apps/web/src/store.ts`

### Codex Subagent Event Handling

Codex child-thread events are correlated back to the parent collab tool call.

Server-side custom behavior:

- Remember receiver thread ids for Codex `collabAgentToolCall` items.
- Attach `parentCollab` metadata to child `item/agentMessage/delta` events.
- Suppress child thread and child agent-message lifecycle notifications that would otherwise leak into the parent conversation.
- Buffer child subagent output deltas in memory in the adapter, keyed by parent thread and collab item id.
- Emit an immediate parent subagent activity when the parent collab item starts.
- Drain buffered child output into the parent collab `item.completed` event as `rawOutput.content`.
- Clear any buffered subagent output when a session is stopped.

Important merge rule:

If upstream changes Codex app-server event shapes, preserve the invariant that the web app receives enough metadata to identify the parent subagent tool call: `itemType: "collab_agent_tool_call"` plus either `data.toolCallId`, `data.parentCollab.itemId`, or `data.item.id`.

### Live Stream Coalescing

The live event path includes local coalescing to avoid repeatedly appending and removing subagent token chunks under load.

Expected behavior:

- Consecutive subagent output chunks for the same tool call are merged in the runtime service.
- Store updates merge live subagent output by parent tool call before activity retention limits are applied.
- Same-timestamp streamed chunks preserve arrival order instead of being sorted by random event ids.
- The reload/snapshot path remains separate and should continue to display the full persisted activity history.

Primary files:

- `apps/web/src/environments/runtime/service.ts`
- `apps/web/src/store.ts`
- `apps/web/src/session-logic.ts`

## Tests Covering The Custom Behavior

Relevant tests live in:

- `apps/server/src/provider/Layers/CodexAdapter.test.ts`
- `apps/web/src/components/chat/MessagesTimeline.test.tsx`
- `apps/web/src/environments/runtime/service.coalescing.test.ts`
- `apps/web/src/session-logic.test.ts`
- `apps/web/src/store.test.ts`

Useful focused commands:

```sh
pnpm --filter t3 test -- src/provider/Layers/CodexAdapter.test.ts
pnpm --filter @t3tools/web test -- src/session-logic.test.ts
pnpm --filter @t3tools/web test -- src/environments/runtime/service.coalescing.test.ts src/store.test.ts src/components/chat/MessagesTimeline.test.tsx
pnpm --filter @t3tools/web test -- src/components/chat/ThreadConversationWidth.test.tsx
```

Before considering the branch healthy, also run:

```sh
pnpm exec vp check
pnpm exec vp run typecheck
pnpm run test
```

## Conversation Width Defaults

This branch intentionally removes the default max width from the main chat conversation and composer surfaces across browser, desktop, and VS Code extension hosts.

Expected behavior:

- By default, conversation rows, the composer, composer banners, and the branch toolbar expand across the available chat window space.
- The VS Code `t3code.ui.threadConversationMaxWidth` setting remains available as an explicit opt-in max-width override.
- Leaving the VS Code setting empty means no maximum width, not the upstream narrow conversation width.

Primary files:

- `apps/web/src/components/chat/ThreadConversationWidth.tsx`
- `apps/web/src/components/chat/ComposerBannerStack.tsx`
- `apps/web/src/components/BranchToolbar.tsx`
- `apps/vscode-extension/package.json`

Relevant tests live in:

- `apps/web/src/components/chat/ThreadConversationWidth.test.tsx`

## VS Code Extension Work

This branch also carries the VS Code extension work that is not assumed to exist on `main`. Treat the VS Code extension, its desktop-backed integration model, workspace-scoped webview behavior, host MCP bridge, release packaging, and related tests as part of this branch's customization set during upstream merges.

The implementation details are intentionally kept in `apps/vscode-extension/IMPLEMENTATION.md` instead of being duplicated here. Unlike the other sections in this file, `CUSTOMIZED.md` should only preserve the merge-maintenance rule for this area: keep the extension work unless `main` has gained an equivalent VS Code extension architecture, then reconcile against the detailed implementation note.

Primary reference:

- `apps/vscode-extension/IMPLEMENTATION.md`

## Mobile EAS Project Ownership

This branch points the mobile Expo/EAS project at the local `quicksaver` owner instead of upstream's `pingdotgg` owner so installable internal mobile builds can be produced without requiring access to the upstream Expo organization.

Expected behavior:

- `apps/mobile/app.config.ts` uses `owner: "quicksaver"` for EAS project ownership.
- `apps/mobile/app.config.ts` uses EAS project id `c65ac46d-6488-49af-b61e-ab9bef78f96e`.

Important merge rule:

If upstream changes the mobile EAS project metadata, preserve the local `quicksaver` owner and project id unless this branch intentionally switches back to the upstream Expo organization or to a new local EAS project. Re-check this before resolving conflicts in `apps/mobile/app.config.ts`, because accepting upstream's `pingdotgg` owner can make local `eas build --profile preview` fail with Expo authorization errors.

Primary file:

- `apps/mobile/app.config.ts`

## Merge Guidance

When merging from upstream, keep these local behaviors unless upstream has an equivalent implementation:

1. Subagent output is isolated inside a subagent activity box, not streamed as top-level assistant text.
2. Each parent subagent/collab tool call renders as one logical activity, not prompt/output/blank rows.
3. Subagent output is buffered or coalesced enough that token-by-token UI churn does not make long threads sluggish.
4. Prompt and output display stays deduplicated in expanded subagent details.
5. Empty subagent placeholder activities stay hidden.
6. Chat conversation and composer surfaces default to no maximum width across all host types.
7. VS Code extension work remains preserved as a local customization unless `main` has an equivalent implementation; use `apps/vscode-extension/IMPLEMENTATION.md` as the detailed source of truth.
8. Mobile EAS project ownership remains pointed at the local Expo project used for installable preview builds unless deliberately changed.

## Retirement Criteria

These local patches can be removed when upstream provides all of the following:

- A canonical parent-child relationship for subagent/collab tool events.
- A UI model that groups subagent prompt and output into one expandable activity.
- Live-stream coalescing or buffering that avoids token-by-token re-render churn for subagent output.
- Tests or contracts that guarantee subagent output does not leak into the main conversation as normal assistant text.

When retiring the local changes, remove the corresponding tests or update them to assert the upstream behavior directly.
