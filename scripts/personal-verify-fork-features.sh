#!/usr/bin/env bash
# Verify the MT Code fork's custom features are still WIRED, not just present.
#
# Why this exists: upstream merges into this fork have repeatedly kept a
# feature's modules, types, and tests while dropping the few lines that CALL
# them. Typecheck stays clean, unit tests stay green, and the feature is
# silently gone from the app (this happened to Goals, the usage "All" window,
# the composer /goal menu, the # thread-reference chip, and the web dictation
# mic). Each check below pins a feature's
# call-site — the line a merge is most likely to lose — not its module.
#
# Run it:
#   - after EVERY upstream merge, before pushing to fork/main
#   - personal-refresh-all.sh runs it before building; a failure aborts the
#     fleet refresh so a broken merge never ships to Mac/Blade/Dell
#
# When a check fails after a merge: the merge dropped that feature's wiring.
# Restore the call site (git log -S the pattern to find the last-good commit),
# do not delete the check. Only remove a check when Sheehan explicitly retires
# the feature.
set -uo pipefail

REPO="${T3_PERSONAL_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$REPO"

fail=0

pending() {
  # pending <file> <grep-pattern> <feature description>
  # Fork feature dropped by the 2026-10-02 upstream orchestrator merge (#2829)
  # with no upstream equivalent, awaiting a port onto orchestration-v2. Warns
  # without failing; turn back into `require` once ported.
  local file="$1" pattern="$2" desc="$3"
  if [[ ! -f "$file" ]] || ! grep -q -- "$pattern" "$file"; then
    echo "PENDING PORT: $desc ($file)" >&2
  fi
}

require() {
  # require <file> <grep-pattern> <feature description>
  local file="$1" pattern="$2" desc="$3"
  if [[ ! -f "$file" ]]; then
    echo "MISSING FILE: $file  ($desc)" >&2
    fail=1
    return
  fi
  if ! grep -q -- "$pattern" "$file"; then
    echo "DROPPED: '$pattern' not found in $file  ($desc)" >&2
    fail=1
  fi
}

# --- Usage "All" window (a7e8c621b) ---
require packages/shared/src/usageFormat.ts "ALL_USAGE_WINDOW_DAYS" "All-window sentinel in shared usage format"
require apps/web/src/components/usage/UsagePage.tsx 'label: "All"' "All option in web usage window picker"
require apps/mobile/src/features/usage/UsageRouteScreen.tsx 'label: "All"' "All option in mobile usage window picker"
require apps/server/src/usage/UsageService.ts "retentionCutoffMs" "All-window scan-cache retention in UsageService"

# --- Goals (86e27ef70, 579221de3, 07d149458) ---
# retired 2026-10-02 (Sheehan: never used; Codex and Grok ship their own goal command): pending apps/server/src/orchestration/projector.ts "thread.goal-set" "goal events in in-memory projector"
# retired 2026-10-02 (upstream orchestrator #2829 owns this now): require apps/server/src/orchestration/projector.ts "thread.queued-turn-dispatched" "queued-turn events in in-memory projector"
# retired 2026-10-02 (Sheehan: never used; Codex and Grok ship their own goal command): pending apps/server/src/orchestration/Layers/ProviderCommandReactor.ts "buildGoalContinuationPrompt" "goal continuation prompt in provider reactor"
# retired 2026-10-02 (Sheehan: never used; Codex and Grok ship their own goal command): pending apps/web/src/components/ChatView.tsx "parseGoalComposerCommand" "/goal interception in ChatView submit path"
# retired 2026-10-02 (Sheehan: never used; Codex and Grok ship their own goal command): pending apps/web/src/components/CommandPalette.tsx "runGoalAction" "Objective actions in command palette"
# retired 2026-10-02 (Sheehan: never used; Codex and Grok ship their own goal command): pending apps/web/src/components/Sidebar.tsx "GoalActiveMarker" "goal marker in sidebar"
# retired 2026-10-02 (Sheehan: never used; Codex and Grok ship their own goal command): pending apps/web/src/components/chat/ChatComposer.tsx "buildBuiltInSlashCommandItems" "/goal items in composer slash menu"
# retired 2026-10-02 (Sheehan: never used; Codex and Grok ship their own goal command): pending apps/web/src/components/chat/ChatComposer.tsx "ComposerGoalBadge" "goal badge rendered by composer"

# --- One-tap Continue as a Continuation Turn (upstream #11716, taken 2026-09-16) ---
# Upstream's Resume after Stop sends a visible "Continue where you left off."
# message. The fork's Continuation has no user message (docs/adr/0005): on
# orchestration-v2 (ported 2026-10-02) onResume sends the authored prompt under
# a per-run hidden message id, and the shared timeline visibility rule hides
# it on every client. A merge that re-takes upstream's onResume or visibility
# code would quietly bring the message back.
require apps/web/src/components/chat/useComposerResume.ts "interruptedRunContinuationMessageId(resumableRunId)" "composer Continue sends the hidden continuation message"
require apps/web/src/components/chat/useComposerResume.ts "buildInterruptedTurnContinuationPrompt()" "composer Continue sends the authored interrupted-turn prompt"
require packages/shared/src/orchestrationV2Timeline.ts "if (isOrchestrationV2HiddenContinuationMessage(item)) return false;" "timeline visibility hides the continuation message"
require apps/server/src/orchestration-v2/ProjectionStore.ts "messageId: MessageId.make(row.message_id)" "SQL timeline index carries message ids for the hidden continuation"

# --- Edit the last user message (PR #7237, ported onto orchestration-v2 2026-10-02) ---
# Built on upstream's rollback: Send rolls back to before the message (files
# kept) and sends the edited text. Upstream has only "Edit from here", which
# returns the message to the composer.
require apps/web/src/components/ChatView.tsx "messageEdit={messageEdit}" "ChatView passes the edit state to the timeline"
require apps/web/src/components/ChatView.tsx "restoreFiles: false" "message edit rolls back without restoring files"
require apps/web/src/components/chat/TimelineUserMessageRow.tsx "<EditUserMessageButton" "edit affordance on the last user message"
require apps/web/src/components/chat/TimelineUserMessageRow.tsx "<InlineUserMessageEditor" "inline editor in the user message bubble"

# --- Cross-thread tools (a0d8862a1, ae1be5092, 146cd13a6) ---
# retired 2026-10-02 (upstream orchestrator #2829 owns this now): require apps/server/src/mcp/McpHttpServer.ts "ThreadReferenceToolkit" "thread_read toolkit registered"
# retired 2026-10-02 (upstream orchestrator #2829 owns this now): require apps/server/src/mcp/McpHttpServer.ts "ThreadRelayToolkit" "thread_list/thread_send toolkit registered"
# retired 2026-10-02 (upstream orchestrator #2829 owns this now): require apps/web/src/components/chat/ChatComposer.tsx "searchThreadReferences" "# thread-reference search in composer"

# --- Voice dictation, web composer (5fe86fbb6, c239c12e0) ---
# retired 2026-11-06 (upstream #30623/#30625 environment dictation owns this now): require apps/web/src/components/chat/ChatComposer.tsx "VoiceTranscriptionPanel" "dictation panel rendered by web composer"
require apps/web/src/components/chat/ChatComposer.tsx "useVoiceSession" "realtime voice session button in web composer"

# --- Computer-use permission/tool approvals (b671c08ef lineage) ---
# retired 2026-10-02 (upstream orchestrator #2829 owns this now): require apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts 'case "permissions_approval"' "permissions approval request kind mapping"
# retired 2026-10-02 (upstream orchestrator #2829 owns this now): require apps/server/src/provider/Layers/CodexSessionRuntime.ts "mcpApprovalRequestKind" "MCP tool/permissions approval routing in Codex runtime"

# --- Resume-on-restart (65d715fb2) ---
# retired 2026-10-02 (upstream orchestrator #2829 owns this now): require apps/server/src/serverRuntimeStartup.ts "sessionStartupReconciler" "startup reconciler runs at boot"

# --- Computer-use agent cursor (b671c08ef) ---
# --- Computer Use ships munim-computer-use (fetched, not built) under MT's identity ---
require scripts/build-desktop-artifact.ts "stageMunimComputerUse" "desktop build stages the pinned munim-computer-use release"
require apps/server/src/desktopControl/desktopMcpLaunch.ts "mtcodeDesktopProfileEnv" "desktop MCP launched under the MT identity profile"
require apps/desktop/src/computerHistory/ComputerHistoryManager.ts "mtcodeDesktopProfileEnv" "Computer History daemon runs under the MT identity profile"
require apps/desktop/src/computerUse/nativeHost.ts "install-native-host" "MT Code registers its Chrome native host"
require apps/desktop/src/app/DesktopApp.ts "scheduleChromeExtensionAutoInstall" "MT Code loads its Chrome extension itself at launch"
require apps/desktop/src/computerUse/chromeExtensionDriver.ts "Load unpacked" "Chrome extension setup drives chrome://extensions"

# --- Computer-use desktop MCP auto-injection into agent sessions (b671c08ef lineage, 2026-08-25) ---
# Every spawned session gets the bundled `mt-desktop` MCP server; user-defined
# servers with the same name win over injection. Since the orchestration-v2
# merge (2026-10-02) the injection lives in the v2 adapters: each driver's
# create() builds `resolveDesktopMcp` (gated on the Computer Use setting) and
# the adapter attaches it next to upstream's t3-code server.
V2=apps/server/src/orchestration-v2/Adapters
require $V2/ClaudeAdapterV2.ts "makeResolveEnabledDesktopMcp" "Claude driver resolves the desktop MCP"
require $V2/ClaudeAdapterV2.ts "withClaudeDesktopMcp(" "desktop MCP injected into Claude sessions"
require $V2/ClaudeAdapterV2.ts "userDefinesDesktopMcp" "user-config-wins guard on Claude desktop MCP injection"
require $V2/CodexAdapterV2.ts "makeResolveEnabledDesktopMcp" "Codex driver resolves the desktop MCP"
require $V2/CodexAdapterV2.ts "codexDesktopMcpAppServerArgs(desktopMcp)" "desktop MCP injected into Codex sessions"
require $V2/CodexAdapterV2.ts 'argument.includes(`mcp_servers.' "user-config-wins guard on Codex desktop MCP injection (launch args)"
require apps/server/src/provider/ProviderHostLive.ts "makeOptionalResolveEnabledDesktopMcp()" "server hands provider packages the desktop MCP via ProviderHost"
require packages/provider-cursor/src/server/adapter.ts "hostDesktopMcp?.resolve" "Cursor driver resolves the desktop MCP"
require packages/provider-cursor/src/server/adapter.ts "cursorSessionMcpServers(input.mcpSession, input.desktopMcp)" "desktop MCP injected into Cursor agents"
require packages/provider-cursor/src/server/adapter.ts "desktopMcp: sessionDesktopMcp" "desktop MCP injected into Cursor agent options"
require packages/provider-cursor/src/server/adapter.ts 'hostDesktopMcp.userDefines("cursor"' "user-config-wins guard on Cursor desktop MCP injection"
require packages/provider-acp/src/server/adapter.ts "withAcpDesktopMcpServers(mcpContext, desktopMcpServers)" "desktop MCP injected into ACP runtimes (Grok, ACP registry agents)"
require packages/provider-acp/src/server/adapter.ts "acpMcpActivation(mcpContext, desktopMcpServers)" "desktop MCP injected into ACP session load/resume"
require packages/provider-grok/src/server/adapter.ts "grokResolveDesktopMcp(options, host.desktopMcp)" "Grok driver resolves the desktop MCP"
require packages/provider-grok/src/server/adapter.ts 'hostDesktopMcp.userDefines("grok"' "user-config-wins guard on Grok desktop MCP injection"
require packages/provider-acp-registry/src/server/adapter.ts "desktopMcp?.resolve" "desktop MCP injected into ACP registry agents (Devin etc.)"
require packages/provider-opencode/src/server/adapter.ts "host.desktopMcp?.resolve" "OpenCode 1.x driver resolves the desktop MCP"
require packages/provider-opencode/src/server/adapter.ts "name: DESKTOP_MCP_SERVER_NAME," "desktop MCP injected into OpenCode 1.x sessions"
require packages/provider-opencode/src/server/v2/adapter.ts "host.desktopMcp?.resolve" "OpenCode 2 adapter resolves the desktop MCP"
require packages/provider-opencode/src/server/v2/adapter.ts "yield\* syncDesktopMcp(directory)" "desktop MCP injected into OpenCode 2 turns"

# --- Computer-use thread view (9c23b7fa6, eb1bdd5e2) ---
require apps/server/src/ws.ts "computerViewStream" "computer view RPCs registered"
require apps/web/src/components/chat/ChatHeader.tsx "ComputerViewDialog" "computer view mounted in chat header"
# The monitor button shows whenever the thread's machine is not the client's
# (SSH hosts, paired backends, a browser on a remote server), not merely when
# the environment id differs from the primary. And an installed app must find
# the binary it ships: the server runs from inside app.asar / server.asar, so
# the packaged copy sits beside that archive (2026-09-29, Dell had no button).
require apps/web/src/components/chat/ChatHeader.tsx "threadMachine: remoteOpenState.mode" "computer view gated on the thread's machine vs this client's"
require apps/server/src/desktopControl/desktopMcpBinary.ts "packagedDesktopMcpCandidates({" "server finds munim-computer-use beside the asar it runs from"

# --- Sidebar linked-PR badge (upstream #4755/#8160 wiring, restored 2026-09-02) ---
# Rows read the linked PR from the host and hold merged/closed state in the
# parent atom; a merge dropped this once and left the sidebar blind to links.
require apps/web/src/components/sidebar/SidebarThreadRow.tsx "useLinkedThreadPullRequest(" "sidebar rows read linked PR status"
# Upstream #10101 (223ff4490) moved PR linking to the server, deleting the
# client-side ThreadChangeRequestSnapshot atom this used to check. The badge
# itself is the fork feature, so the check now follows it to its new source.
require apps/web/src/components/sidebar/SidebarThreadRow.tsx "prStatusIndicator(pr, linkedPullRequestStatus?.sourceControlProvider)" "sidebar renders the linked-PR badge"

# --- Artwork + app icon pickers (44cf90dc0, 0efc0e293) ---
require apps/web/src/components/settings/AppearanceSettingsPanel.tsx "SidebarArtworkRow" "artwork picker in settings"
require apps/web/src/components/settings/AppearanceSettingsPanel.tsx "AppIconRow" "app icon picker in settings"

# --- Usage refresh rule (e7c556759) ---
require apps/web/src/state/usage.ts "usageEnvironmentScope" "refresh-must-answer rule feeds usage state"

# --- Open-in-editor bundle discovery (833ef53b1) ---
require packages/contracts/src/editor.ts "VSCodium" "extended macAppName editor map"

# --- Branding (6beb464fb, f136dbff8) ---
require apps/server/src/appDisplayName.ts "appDisplayName" "backend self-naming helper"
require apps/web/index.html "boot-shell-wordmark" "MT wordmark boot splash"

# --- PR upstream cards (27553c695) ---
require apps/web/src/components/pullRequest/PullRequestsPage.tsx "PullRequestUpstreamCard" "upstream PR cards in pull-requests route"

# --- Connect providers: T3 relay baked + relay-capable default (2026-08-25) ---
require scripts/lib/connect-public-providers.ts "T3_CONNECT_PUBLIC_PROVIDER" "T3 Connect provider baked into every client build"
require apps/web/src/cloud/connectProviders.ts "relayCapable" "relay-capable provider preferred as default identity"

# --- munim new-thread env helpers (e51e0fc8e) ---
require apps/web/src/hooks/useHandleNewThread.ts "shouldReadProjectFileForNewThreadDefaults" "new-thread project-file defaults"

# --- File/PDF attachments (c32c7e223, restored 2026-08-29) ---
# A 2026-08-17 integrate left contracts on the old "pdf" attachment model while
# the server moved to upstream's generic "file" type, so the server bundle threw
# "PROVIDER_SEND_TURN_MAX_FILE_BYTES is not defined" on boot and crash-looped.
# retired 2026-10-02 (upstream orchestrator #2829 owns this now): require packages/contracts/src/orchestration.ts "ChatFileAttachment" "generic file attachment schema"
# retired 2026-10-02 (upstream orchestrator #2829 owns this now): require packages/contracts/src/orchestration.ts "ChatUnknownAttachment" "forward-compatible unknown attachment schema"
require apps/server/src/attachmentStore.ts 'case "file"' "file attachments get a stored path"
# retired 2026-10-02 (upstream orchestrator #2829 owns this now): require apps/server/src/provider/Layers/CursorAdapter.ts 'attachment.type !== "image"' "non-image attachments sent as ACP resource links"
require apps/web/src/components/chat/TimelineUserMessageRow.tsx "filter(isImageAttachment)" "timeline image grid filters non-images"

# --- WS client analytics props (restored 2026-08-29) ---
# The merge dropped this argument from the makeWsRpcLayer call, so per-client
# telemetry never reached the RPC layer.
require apps/server/src/ws.ts "clientAnalyticsProps," "client analytics props passed into the ws rpc layer"

# --- Update changelog on every channel (5e8467899) ---
# Upstream gates the release-notes popover/tooltip to nightly; MT Code ships a
# single latest track with fullChangelog on, so the gate must stay removed.
require apps/web/src/components/sidebar/SidebarUpdatePill.tsx 'showUpdateDetails && (state?.releaseNotes.length ?? 0) > 0' "release-notes popover not gated to nightly"
require apps/web/src/components/sidebar/SidebarUpdateReleaseNotes.tsx 'if (state.releaseNotes.length === 0) {' "release-notes body not gated to nightly"

# --- Desktop auto-download / auto-install (personal fork) ---
# The 2026-09-01 sync silently broke auto-install when upstream turned
# installDownloadedUpdate into a function (the fork line yielded the function).
require apps/desktop/src/updates/DesktopUpdates.ts 'const fullChangelog = true;' "release notes fetched on every update channel"
require apps/desktop/src/updates/DesktopUpdates.ts 'yield\* downloadAvailableUpdate;' "auto-download when an update becomes available"
require apps/desktop/src/updates/DesktopUpdates.ts 'yield\* installDownloadedUpdate(info.version);' "auto-install pinned to the downloaded version"
# Remote-update flow must treat the fork's in-flight auto-install as prepared.
require apps/desktop/src/updates/DesktopRemoteUpdates.ts 'ready-to-install' "remote update publishes ready-to-install"
require scripts/build-desktop-artifact.ts "VC.Runtimes.x86.x64.Spectre" "Windows build preflight probes the real VS 2022 Spectre component id (upstream's VC.Tools.*.Spectre does not exist)"

# --- MT wordmark alignment (brand tuning, do NOT adopt upstream's sizing) ---
# The MT mark is hand-tuned: 12px tall and nudged down 2px, because the glyph is
# top-heavy (ink centroid at 45%) so cap-height box sizing reads high. The
# 2026-09-15 sync replaced it with upstream's `h-[1cap]` and shrank the mark.
# Upstream's T3Wordmark keeps 1cap; only MTWordmark is exempt.
require apps/web/src/components/sidebar/SidebarChrome.tsx 'h-3 w-auto shrink-0 translate-y-\[2px\]' "MT wordmark keeps its hand-tuned 12px height and 2px nudge"

# --- Plugin marketplace (2026-09-16, a3455de80b / 06fffa29e3) ---
# Codex plugins are read through the app-server with lenient decoders; the
# CLI-only path silently dropped every Codex plugin once codex 0.154 emitted
# path-less remote records. The palette action is fork-only UI. Since
# 2026-09-29 the page is ChatGPT-style: Plugins / Apps / MCPs / Skills section
# tabs with counts, the harness demoted to a filter, and a Skills section that
# lists the environment's standalone skills.
require apps/server/src/plugins/CodexPluginMarketplace.ts "decodeCodexRuntimeCatalog" "Codex app-server catalog decoding in the plugin marketplace"
require apps/web/src/components/CommandPalette.tsx 'title: "Browse plugins"' "Browse plugins command-palette action"
require apps/web/src/components/settings/pluginMarketplace/PluginMarketplace.tsx 'aria-label="Plugin sections"' "Plugins / Apps / MCPs / Skills section tabs on the plugin marketplace page"
require apps/web/src/components/settings/pluginMarketplace/PluginMarketplace.tsx 'aria-label="Harness"' "harness filter on the plugin marketplace page"
require apps/web/src/components/settings/pluginMarketplace/PluginMarketplaceSkills.tsx "fetchEnvironmentSkillInventory" "standalone skills in the plugin marketplace Skills section"

# --- Usage limits for every driver (2026-09-16, 20308ea78b) ---
# Cursor and OpenCode publish subscription windows into upstream's Limits
# view; the fork-only AccountLimits strip/hover card was removed the same day.
require packages/provider-cursor/src/server/driver.ts "readCursorUsageLimits" "Cursor usage-limit probe wired into CursorProvider"
require packages/provider-opencode/src/server/driver.ts "loadOpenCodeUsageLimits" "OpenCode usage-limit probe wired into OpenCodeProvider"

# --- Usage-limit recovery (upstream #11215 + #9012 port; kept over #12458, 2026-09-18) ---
require apps/server/src/persistence/Migrations.ts "ProjectionUsageLimitResume" "usage-limit resume migration (fork id 56)"
# retired 2026-10-02 (upstream orchestrator #2829 owns this now): require apps/server/src/server.ts "UsageLimitResumeReactor.layer" "usage-limit resume sweep wired"
# retired 2026-10-02 (upstream orchestrator #2829 owns this now): require apps/server/src/provider/Layers/ClaudeAdapter.ts "usageLimitFailureFor" "Claude usage-limit classification"
# retired 2026-10-02 (upstream orchestrator #2829 owns this now): require packages/client-runtime/src/state/threadSettled.ts "threadUsageLimitResetsAt" "snooze-until-reset source"
# retired 2026-10-02 (upstream orchestrator #2829 owns this now): require apps/server/src/orchestration/decider.ts 'reason: "cleared"' "settle/archive disarm an armed usage-limit resume"

# --- Upstream PRs taken 2026-09-18 (open upstream; keep until they merge there) ---
# retired 2026-10-02 (upstream orchestrator #2829 owns this now): require apps/server/src/orchestration/ThreadSettlementPolicy.ts "autoSettleScope" "auto-settle scope: threads without a PR (#12258)"
# retired 2026-10-02 (upstream orchestrator #2829 owns this now): require apps/server/src/orchestration/ThreadSettlementPolicy.ts "snoozeWakeAt" "woken snoozed threads get a fresh auto-settle window (#12525)"
require apps/server/src/process/externalLauncher.ts "readHostEnv(COMMAND_LOOKUP_ENV_NAMES)" "editor discovery reads the hydrated PATH (#12501)"
require apps/server/src/process/externalLauncher.ts "resolveMacAppBundle" "macOS editor app-bundle discovery"
# retired 2026-10-02 (upstream orchestrator #2829 owns this now): require apps/server/src/provider/Layers/CodexSessionRuntime.ts "RECOVERABLE_THREAD_RESUME_CAPABILITY_SNIPPETS" "Codex resume falls back on unsupported list_turns (#12468)"
# retired 2026-10-02 (Sheehan: codex queue never used; upstream closed #12466 unmerged): pending apps/server/src/orchestration/Layers/ProviderCommandReactor.ts '"thread.session-start-requested" ||' "Codex wake for externally queued messages (#12466)"

if [[ "$fail" -ne 0 ]]; then
  echo "" >&2
  echo "fork-feature verification FAILED — an upstream merge dropped call sites." >&2
  echo "Restore the wiring before pushing to fork/main (git log -S '<pattern>' finds the last-good commit)." >&2
  exit 1
fi
echo "fork-feature verification OK (all custom call sites present)"
