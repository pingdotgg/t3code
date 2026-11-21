import { describe, expect, it } from "vite-plus/test";

import {
  classifyRenameOccurrence,
  findRenameOccurrences,
  FORK_RENAME_RULES,
  type RenameClass,
} from "./forkRenameRules.ts";

/** The class of the first t3 hit on `line` in a file at `path`. */
const classOf = (path: string, line: string): RenameClass | "unclassified" => {
  const [occurrence] = findRenameOccurrences(path, line);
  if (!occurrence) throw new Error(`no t3 in ${line}`);
  return classifyRenameOccurrence(FORK_RENAME_RULES, occurrence)?.class ?? "unclassified";
};

describe("findRenameOccurrences", () => {
  it("finds every hit, including two inside one token", () => {
    const hits = findRenameOccurrences(
      "a.ts",
      'import x from "@t3tools/t3-terminal";\nconst y = 1;',
    );
    expect(hits.map((hit) => [hit.token, hit.offset])).toEqual([
      ["@t3tools/t3-terminal", 1],
      ["@t3tools/t3-terminal", 9],
    ]);
  });
});

describe("FORK_RENAME_RULES", () => {
  it.each<readonly [string, string, RenameClass]>([
    ["packages/shared/src/imageDimensions.ts", "const n = data.getUint32(0);", "false-positive"],
    ["apps/web/src/a.ts", 'import { X } from "@t3tools/contracts";', "identifier"],
    ["apps/web/src/a.tsx", "export function T3ComposerEditorView() {}", "identifier"],
    ["apps/web/src/a.ts", 'const message = "Restart T3 Code?";', "display"],
    [
      "apps/web/src/components/clerk/T3ConnectUserProfilePage.tsx",
      "  make it available through T3\n  Connect.",
      "upstream-reference",
    ],
    ["apps/web/src/a.tsx", "  Open a T3\n  thread.", "display"],
    ["apps/server/src/cli/config.ts", 'Config.String("T3CODE_HOME")', "persisted"],
    ["scripts/build-desktop-artifact.ts", "process.env.T3CODE_DESKTOP_PLATFORM", "identifier"],
    [
      "apps/server/scripts/dev-replay-agent.ts",
      '          agentInfo: { name: "t3-dev-replay", version: "1" },',
      "identifier",
    ],
    ["apps/server/src/process/agentScope.ts", 'const S = "app-t3code.slice";', "identifier"],
    [
      "apps/server/src/cloud/serviceProtection.test.ts",
      '        "/home/theo/.config/systemd/user.conf.d/90-t3code-protect.conf",',
      "identifier",
    ],
    ["apps/server/src/process/agentScope.test.ts", '            "app-t3code.slice",', "identifier"],
    [
      "apps/server/src/orchestration-v2/ProviderTurnStartService.test.ts",
      '            expect(yield* branchConfig("t3-merge-base")).toBe(expected.base);',
      "kept",
    ],
    [
      "apps/web/src/components/sidebar/updateEverythingRun.test.ts",
      'const KEY = "t3code:update-everything-result:v1";',
      "identifier",
    ],
    [
      "packages/shared/src/remote.ts",
      "  `t3code://pair?${new URLSearchParams([[PAIRING_APP_LINK_PARAM, pairingUrl]])}`;",
      "upstream-reference",
    ],
    ["evals/mcp-tool-use/run.ts", "  const t3 = visibleT3Tools(options);", "identifier"],
    [
      "evals/mcp-tool-use/run.ts",
      "    ...t3.filter((tool) => !alwaysLoaded.has(tool.name)).map((tool) => tool.name),",
      "identifier",
    ],
    ["evals/mcp-tool-use/secret-grading.ts", 'const SECRET = "T3SECRET";', "identifier"],
    ["scripts/install.sh", '    t3_cwd="$(pwd -P && printf .)"', "identifier"],
    ["scripts/install.sh", 'case "$t3_home" in', "identifier"],
    [
      "packages/shared/src/threadLinks.test.ts",
      "      /^https:\\/\\/preview\\.t3\\.codes\\/threads\\//,",
      "wire-peer",
    ],
    [
      "packages/shared/src/composerContextReferences.test.ts",
      '        reference("env-2", "t3", "Written"),',
      "kept",
    ],
    [
      "packages/shared/src/composerContextReferences.test.ts",
      '        "[Written](https://app.t3.codes/threads/env-2/t3)",',
      "wire-peer",
    ],
    ["scripts/install.sh", '    t3_home="${t3_cwd%??}/$t3_home"', "identifier"],
    [
      "apps/mobile/src/components/ui/x.ts",
      '  if (dark && (!card || themeId === "t3-code")) {',
      "kept",
    ],
    [
      "apps/mobile/src/features/x.test.ts",
      '    const themeIds = { light: "t3-code", dark: "t3-code" } as const;',
      "kept",
    ],
    ["packages/contracts/src/auth.ts", 'export const ID = "t3code-peer-link";', "wire-peer"],
    [
      "apps/desktop/src/app/DesktopLifecycle.test.ts",
      '          "T3CODE://pair?token=spent",',
      "identifier",
    ],
    [
      "packages/shared/src/t3McpToolPresentation.ts",
      "    /^(?<server>t3[-_]code[-_]direct|t3-code)(?:[.:/])(?<tool>.+)$/i.exec(",
      "agent-facing",
    ],
    [
      "apps/server/src/cliCompileCache.test.ts",
      '      `CACHE=${root}/cache/t3code/compile-cache`.replaceAll("\\\\", "/"),',
      "identifier",
    ],
    [
      "apps/desktop/src/menuBar/menuBarSources.ts",
      '  if (profile?._tag === "BearerConnectionProfile" && profile.authorization === "t3-connect") {',
      "kept",
    ],
    [
      "apps/desktop/src/menuBar/menuBarSources.test.ts",
      '          bearerProfile("t3-connect"),',
      "kept",
    ],
    [
      "packages/shared/src/managedPolicyFile.ts",
      '      return "/etc/t3code/policy.json";',
      "identifier",
    ],
    [
      "packages/shared/src/managedPolicyFile.ts",
      '      return "/Library/Application Support/T3Code/policy.json";',
      "identifier",
    ],
    ["packages/shared/src/managedPolicyFile.ts", 'open({ library: "t3-advapi32" });', "identifier"],
    [
      "scripts/check-changed.ts",
      '  files.includes("docs/user/t3-connect-troubleshooting.md")',
      "identifier",
    ],
    [
      "scripts/profile-startup-modules.mjs",
      'const key = "__t3codeStartupModuleProfiler";',
      "identifier",
    ],
    [
      "apps/server/src/telemetry/ProviderUsageAnalytics.ts",
      '  if (origin.subagent) return "t3_child";',
      "wire-peer",
    ],
    ["apps/server/src/mcp/McpInvocationContext.ts", 'const H = "t3-mode-limit";', "wire-peer"],
    [
      "packages/contracts/src/relay.ts",
      'HttpApiEndpoint.get("getLink", "/v1/client/t3chat-link", {',
      "wire-peer",
    ],
    [
      "apps/web/src/components/cloud/TunnelUsage.tsx",
      'export const T3CHAT_SUBSCRIPTION_URL = "https://t3.chat/settings/subscription";',
      "wire-peer",
    ],
    [
      "packages/contracts/src/relay.ts",
      "export class RelayT3ChatLink extends Schema.Class<RelayT3ChatLink>(",
      "wire-peer",
    ],
    ["apps/web/src/components/clerk/x.tsx", "                        t3.chat", "wire-peer"],
    ["docs/user/faq.md", "[More](./remote-access.md#more-machines-with-t3-chat)", "wire-peer"],
    [
      "apps/web/src/components/clerk/useT3ChatLink.ts",
      "export function useT3ChatLink() {",
      "wire-peer",
    ],
    ["scripts/build-npm-launcher.ts", "    t3code: { databaseMigration },", "kept"],
    [
      "scripts/build-npm-launcher.ts",
      "/** `t3code` is read back by npmReleaseDatabaseMigration. */",
      "kept",
    ],
    [
      "evals/mcp-tool-use/run.ts",
      '  if (content.includes("<t3_code_")) return [];',
      "agent-facing",
    ],
    [
      "packages/shared/src/assistantCitations.ts",
      'const CITATION_PROTOCOL = "t3-citation:";',
      "persisted",
    ],
    ["apps/server/src/x.ts", 'headers["x-t3-relay-delivery-id"]', "wire-peer"],
    ["apps/server/src/x.ts", "const total = allT3.processStarts;", "wire-peer"],
    [
      "packages/contracts/src/t3ProjectFile.ts",
      'export const T3_PROJECT_FILE_NAME = "t3.json";',
      "persisted",
    ],
    [
      "packages/contracts/src/t3ProjectFile.ts",
      'const schema = "https://t3.codes/schema/t3.json";',
      "kept",
    ],
    ["apps/server/src/x.ts", '"mcp__t3-code__t3_thread_list",', "agent-facing"],
    ["packages/shared/src/mcpApp.ts", 'export const MCP_APP_OUTPUT_KEY = "t3McpApp";', "kept"],
    // Tokens never include quotes, so these quoted literals must still match their rules.
    [
      "packages/client-runtime/src/connection/catalog.ts",
      'authorization: Schema.optionalKey(Schema.Literal("t3-connect")),',
      "kept",
    ],
    ["apps/server/src/cli/config.ts", 'Config.String("T3CODE_PORT")', "persisted"],
    ["packages/shared/src/forkLegacyEnv.ts", 'const LEGACY_PREFIX = "T3CODE_";', "kept"],
    [
      "apps/server/src/provider/ProviderCredentialStore.ts",
      'binding: { owner: "t3" as const, key },',
      "wire-peer",
    ],
    ["README.md", "Fork of https://github.com/pingdotgg/t3code", "upstream-reference"],
    // Dotted uses of kept names keep them too.
    ["apps/web/src/a.tsx", "const all = snapshot?.groups.allT3;", "wire-peer"],
    ["apps/server/src/a.ts", "t3CodeVersion: packageJson.version,", "wire-peer"],
    ["packages/provider-cursor/src/server/auth.ts", 'credentialOwner: "t3" as const,', "wire-peer"],
    [
      "packages/provider-core/src/server/auth.ts",
      'readonly owner: "provider" | "t3";',
      "wire-peer",
    ],
    ["apps/server/src/provider/model-manifest.json", '"t3CodeRange": ">=0.0.44",', "kept"],
    ["apps/server/src/provider/x.ts", "satisfies(version, entry.t3CodeRange)", "kept"],
    ["scripts/install.test.ts", 'pack(root, "legacy", { t3: "t3 v1.2.3" })', "kept"],
    // Mobile keeps its own names but follows renamed shared code.
    ["apps/mobile/src/lib/a.ts", 'import { T3_PROJECT_FILE_NAME } from "x";', "identifier"],
    [
      "apps/marketing/src/pages/schema/t3.json.ts",
      'import { buildT3ProjectFileJsonSchema } from "@t3tools/shared/t3ProjectFile";',
      "identifier",
    ],
    ["apps/mobile/src/lib/a.ts", "  resolveT3McpToolPresentation,", "identifier"],
    ["apps/mobile/src/a.tsx", ') : presentation.attribution === "t3code" ? (', "identifier"],
    ["apps/mobile/src/a.tsx", "Sent by T3 Code", "display"],
    ["apps/mobile/src/a.tsx", 'if (props.icon === "t3-code") {', "agent-facing"],
    ["apps/mobile/src/a.tsx", 'import { T3Wordmark } from "../../components/T3Wordmark";', "kept"],
    ["apps/mobile/src/a.tsx", '<Text className="font-t3-medium">', "kept"],
    ["apps/mobile/app.config.ts", 'name: "T3 Code",', "kept"],
    [
      "apps/mobile/src/features/review/nativeReviewDiffAdapter.test.ts",
      'createNativeReviewDiffTheme("dark", "t3-code", appTheme("t3-code", "dark"));',
      "kept",
    ],
    ["docs/operations/x.md", "defaults to dark appearance and the `t3-code` palette", "kept"],
    ["README.md", "brew install --cask t3-code", "upstream-reference"],
    ["vite.config.ts", '"apps/mobile/src/native/T3ComposerEditor.ios.tsx",', "kept"],
    [
      "apps/mobile/scripts/permissions-service.test.ts",
      "// oxlint-disable-next-line t3code/no-global-process-runtime -- host Foundation.",
      "identifier",
    ],
    [
      "scripts/build-cli-archive.ts",
      '  const executableName = input.platform === "win" ? "t3.exe" : "t3";',
      "identifier",
    ],
    ["scripts/build-cli-archive.ts", '    "Invoke-TrustedSigning t3.exe",', "identifier"],
    [
      "scripts/build-cli-archive.ts",
      "  return `t3-${version}-${cliArchivePlatformKey(platform, arch)}`;",
      "kept",
    ],
    [
      "scripts/build-cli-archive.ts",
      " * Fork: the archive holds the executable as `lathe` and as `t3` (see",
      "kept",
    ],
    [
      "scripts/build-cli-archive.ts",
      "  const peOffset = view.getUint32(0x3c, true);",
      "false-positive",
    ],
    [
      "apps/mobile/modules/t3-terminal/README.md",
      "`t3code/custom-io-ordered-feed` branch when vendored, based on VVTerm's",
      "kept",
    ],
    [
      ".github/scripts/relay-state-output.test.cjs",
      '"T3CODE_RELAY_CLIENT_OTLP_TRACES_URL=https://example.invalid/traces\\n" +',
      "upstream-reference",
    ],
    ["apps/web/src/lib/syntaxThemes.test.ts", '.toBe("t3-graphite-dark");', "identifier"],
    [
      "apps/server/src/cli/thread.ts",
      "      detail: `The server sent an unexpected ${tool} result. Update the t3 CLI to match the server.`,",
      "display",
    ],
    ["apps/server/src/cli/thread.ts", '      clientName: "t3-thread-cli",', "identifier"],
    ["apps/server/src/mcp/AcpMcpStdioBridge.ts", 'clientName: "t3-code-acp-cli" }', "wire-peer"],
    ["apps/server/src/mcp/AcpMcpStdioBridge.ts", "const id = `t3-cli-${nextId++}`;", "identifier"],
    ["apps/server/src/serviceLauncher.test.ts", '"t3_boot_service_unit=bad",', "kept"],
    ["apps/mobile/src/lib/projectIcon.test.ts", '["t3code", "T3", "teal"],', "kept"],
    [
      "packages/shared/src/paletteSearch.test.ts",
      'expect(rankTitles("t3coed", [thread("t3code perf audit")])).toEqual([',
      "upstream-reference",
    ],
    [
      "apps/mobile/src/lib/composerChipPresentation.test.ts",
      'const theme = getMobileThemeVariables("t3-code", "dark");',
      "kept",
    ],
    [
      "apps/web/src/components/sidebar/SidebarThreadRow.tsx",
      "            T3",
      "upstream-reference",
    ],
    [
      "apps/server/src/vcs/GitVcsDriverCore.ts",
      "const key = (branch: string) => `branch.${branch}.t3-merge-base`;",
      "kept",
    ],
    ["apps/server/src/vcs/GitVcsDriverCore.test.ts", '"branch.feature.t3-merge-base-ref",', "kept"],
    [
      "apps/server/src/cloud/servicePreflight.ts",
      "install this exact CLI: `curl -fsSL https://t3.codes/install.sh | sh`.",
      "upstream-reference",
    ],
    [
      "packages/contracts/src/environmentHttp.ts",
      '  "this-device-cant-reach-t3-connect",',
      "upstream-reference",
    ],
    [
      "apps/server/src/provider/userInputAttachments.test.ts",
      '            "Lantern\\t\\t37",',
      "false-positive",
    ],
    [
      "apps/desktop/src/app/DesktopCliShim.test.ts",
      '      shimPath: "C:\\\\Users\\\\José\\\\.t3\\\\bin\\\\t3.cmd",',
      "identifier",
    ],
    [
      "apps/web/src/components/CommandPalette.logic.test.ts",
      '    expect(search("t3", true)).toEqual([["Projects", ["t3code"]]]);',
      "upstream-reference",
    ],
    [
      ".task-cache.json",
      '  "endpoint": "https://t3-task-cache.pinglabs.workers.dev/projects/t3code"',
      "upstream-reference",
    ],
    [
      "infra/task-cache/src/resources.ts",
      '  return stage === "prod" ? "t3-task-cache" : `t3-task-cache-${stage}`;',
      "upstream-reference",
    ],
    [
      "infra/task-cache/src/telemetry.ts",
      "/* oxlint-disable t3code/no-global-process-runtime -- This bootstrap runs before dependencies are installed. */",
      "identifier",
    ],
    [
      ".github/actions/setup-ci-deps/action.yml",
      "        T3_TASK_CACHE_READ_TOKEN: ${{ inputs.task-cache-read-token }}",
      "upstream-reference",
    ],
    [
      "apps/server/src/mcp/toolkits/orchestrator/handlers.ts",
      "    t3_background_wait: McpToolAccess.actsAsCaller((input) =>",
      "agent-facing",
    ],
    [
      "apps/web/src/lib/readableSyntaxTheme.ts",
      'export const READABLE_LIGHT_THEME_NAME = "t3-light";',
      "identifier",
    ],
    [
      "apps/web/src/components/guest/GuestPage.tsx",
      'const AWAITING_ROWS_KEY = "t3:guest-awaiting-rows";',
      "identifier",
    ],
    [
      "packages/contracts/src/guestShare.ts",
      "export const guestSessionCookieName = (shareId: string) => `t3_guest_${shareId}`;",
      "identifier",
    ],
    [
      "oxlint-plugin-t3code/rules/react-effect-budget.ts",
      "const JUSTIFIED = /oxlint-disable-next-line[^\\n]*t3code\\/react-effect-budget\\s+--\\s*\\S/;",
      "identifier",
    ],
    [
      "packages/client-runtime/src/connection/diagnosis.ts",
      'return "the-host-runs-an-older-t3-code";',
      "display",
    ],
    [
      "apps/server/src/telemetry/AnalyticsService.ts",
      'Config.withDefault("https://ingest.t3.codes"),',
      "wire-peer",
    ],
    [
      "apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts",
      '            "mcp_servers.t3-code": {',
      "agent-facing",
    ],
    [
      "apps/server/src/observability/Metrics.ts",
      'Metric.gauge("t3_server_resident_bytes", {',
      "identifier",
    ],
    [
      "apps/server/src/resourceTelemetry/ProcessGroupMetrics.ts",
      'Metric.gauge("t3_process_group_cpu_percent", {',
      "identifier",
    ],
    [
      "apps/web/src/components/chat/threadFindActionBus.ts",
      'const THREAD_FIND_QUERY_EVENT = "t3:thread-find-query";',
      "identifier",
    ],
    [
      "apps/web/src/components/pullRequest/pullRequestDetail.logic.ts",
      'const KEY = "t3.pullRequests.recentDetails";',
      "identifier",
    ],
    [
      "apps/server/src/preview/ServerBrowserPage.ts",
      'worldName: "t3-preview-metrics",',
      "identifier",
    ],
    [
      "apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts",
      '["-c", SCRIPT, "t3-claude", options.command],',
      "identifier",
    ],
    [
      "apps/server/src/provider/CodexManagedTokenBroker.ts",
      "return { endpoint: `\\\\\\\\.\\\\pipe\\\\t3-token-${id}` };",
      "identifier",
    ],
    [
      "apps/server/src/process/agentScope.ts",
      'if (!unit.startsWith("t3code-")) return;',
      "identifier",
    ],
    ["apps/web/vite/warmBundledDev.ts", 'const ID = "t3code-startup-warmup";', "identifier"],
    [
      "scripts/seed-issue-21397.py",
      "NEW_DIR must not exist and must not be under the live ~/.t3. Then run the printed",
      "identifier",
    ],
    [
      "packages/shared/src/t3McpToolPresentation.ts",
      'const LEGACY_SERVER_ALIASES = new Set(["t3-code", "t3_code", "t3code"]);',
      "agent-facing",
    ],
    [
      "packages/shared/src/latheMcpToolPresentation.ts",
      'const LATHE_MCP_SERVER_ALIASES = new Set(["lathe", "t3-code", "t3_code", "t3code"]);',
      "kept",
    ],
    [
      "packages/provider-acp/src/server/runtimeModel.ts",
      "  if (/^t3[-_ ]?code$/i.test(id)) {",
      "agent-facing",
    ],
    [
      "packages/provider-acp/src/server/runtimeModel.ts",
      "  if (/^(?:lathe|t3[-_ ]?code)$/i.test(id)) {",
      "kept",
    ],

    [
      "apps/desktop/src/app/DesktopLegacyLocalStorage.ts",
      "// upstream's T3 Code (Alpha) directory",
      "kept",
    ],
    ["apps/mobile/src/a.ts", 'const href = "t3-context://v1/file/a";', "persisted"],
    [
      "apps/mobile/src/a.ts",
      "// oxlint-disable-next-line t3code/no-global-process-runtime",
      "identifier",
    ],
    [
      "packages/shared/src/composerContextClipboard.ts",
      'const ATTR = "data-t3-context-fragment";',
      "kept",
    ],
    [
      "apps/web/src/terminal/ghostty/runtime.ts",
      "        t3_write_pty: (terminal: number) => {",
      "kept",
    ],
    ["scripts/build-desktop-artifact.ts", '    name: "t3code",', "kept"],
    [
      "apps/desktop/src/snapShot/HyprlandSnapShot.test.ts",
      'hyprlandCaptureShortcut("com.t3tools.T3Code", "/home/test", directory);',
      "kept",
    ],
    [
      "apps/web/src/terminal/ghostty/runtimeAbi.test.ts",
      '"\\u001b]8;;https://t3.codes/docs\\u001b\\\\linked",',
      "upstream-reference",
    ],
    [
      "packages/ssh/src/tunnel.test.ts",
      'expect(script).toContain("for name in lathe t3; do");',
      "kept",
    ],
    // Upstream credit, its company, and what project sync imports from.
    [
      "scripts/build-desktop-artifact.ts",
      "copyright: `${name} is a fork of T3 Code by T3 Tools.`,",
      "upstream-reference",
    ],
    [
      "docs/user/telemetry.md",
      "To share usage data with T3 Tools, the makers of T3 Code, set it",
      "upstream-reference",
    ],
    [
      "apps/web/src/a.tsx",
      "Notices for tools used by T3 Code. T3 Tools publishes them.",
      "display",
    ],
    [
      "apps/web/src/components/settings/ProjectsSettings.tsx",
      "Sync from another T3 install",
      "upstream-reference",
    ],
    [
      ".github/SECURITY.md",
      "affecting T3 Code or T3 Tools-operated infrastructure",
      "upstream-reference",
    ],
    // CLI archives keep their legacy names, and the directory inside keeps t3-*.
    ["scripts/fork-cli-release-assets.test.ts", '"t3-0.0.1-linux-x64.tar.gz"', "kept"],
    ["scripts/install.test.ts", "const stem = `t3-${version}-${key}`;", "kept"],
    ["scripts/lib/forkCliArchive.ts", " * Adds `t3` beside the signed `lathe`", "kept"],
    ["packages/shared/src/git.test.ts", 'isTemporaryWorktreeBranch("t3code/deadbeef")', "kept"],
    ["packages/shared/src/forkIdentity.test.ts", '  scheme: "t3code",', "kept"],
    ["packages/ssh/src/auth.test.ts", '      assert.equal(env.DISPLAY, "t3code");', "identifier"],
    [
      "apps/desktop/scripts/electron-launcher.test.mjs",
      '      "exec \x27/repo/Electron\x27 --t3code-dev-root=\x27/repo\x27",',
      "identifier",
    ],
    [
      "apps/server/src/orchestration-v2/ProjectCommands.test.ts",
      '    for (const text of ["T3", "é", "किखि"]) {',
      "kept",
    ],
    [
      "apps/server/src/vcs/VcsProjectConfig.test.ts",
      '      path.join(root, ".t3code"),',
      "upstream-reference",
    ],
    [
      "apps/server/src/project/RepositoryIdentityResolver.test.ts",
      'expect(identity?.owner).toBe("t3tools");',
      "upstream-reference",
    ],
    [
      "apps/server/src/orchestration-v2/testkit/fixtures/x/cursor_transcript.ndjson",
      '{"cwd":"/work/t3code"}',
      "identifier",
    ],
    [
      "apps/web/src/lib/openPullRequestLink.test.ts",
      'normalizeGitRemoteUrl("git@ssh.dev.azure.com:v3/T3Tools/Platform/T3Code");',
      "upstream-reference",
    ],
    [
      "packages/source-control-gitlab/src/server/GitLabCli.test.ts",
      '        "path=t3code",',
      "upstream-reference",
    ],
    // Upstream lines the fork replaced with FORK_IDENTITY, seen only on the mirror.
    [
      "apps/server/src/httpCors.ts",
      'export const ORIGINS = ["t3code://app", "t3code-dev://app"] as const;',
      "upstream-reference",
    ],
    [
      "apps/server/src/cli/invocation.ts",
      'const packageRoot = path.join(prefix, "lib/node_modules/t3");',
      "upstream-reference",
    ],
    [
      "apps/desktop/src/app/DesktopCliShim.ts",
      'export const MARKER = "Written by T3 Code: runs the bundled t3 CLI.";',
      "upstream-reference",
    ],
    [
      "packages/client-runtime/src/state/projectGrouping.test.ts",
      '      makeProject("first", "/work/t3code", { title: "t3code" }),',
      "upstream-reference",
    ],
    [
      "packages/shared/src/changeRequestUrl.test.ts",
      '      repository: "acme/platform/_git/t3code",',
      "upstream-reference",
    ],
    [
      "apps/desktop/scripts/electron-launcher.mjs",
      'const APP_PROTOCOL_SCHEMES = isDevelopment ? ["t3code-dev"] : ["t3code"];',
      "upstream-reference",
    ],
    [
      "apps/web/src/connection/storage.ts",
      'const DATABASE_NAME = "t3code:connection-runtime";',
      "kept",
    ],
    ["apps/web/src/connection/storage.ts", 'const PREFIX = "t3code:github-routing:";', "persisted"],
    ["apps/web/public/forkLegacyStorage.js", '    ["t3code:", "lathe:"],', "kept"],
    [
      "scripts/lib/forkCliArchive.test.ts",
      "assert.match(listing.stdout, /^l.* t3-1\\.2\\.3-linux-x64\\/t3 -> lathe$/m);",
      "kept",
    ],
    [
      "apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.test.ts",
      '          key: "t3-code",',
      "kept",
    ],
    [
      "packages/provider-pi/src/server/mcpExtensionSource.test.ts",
      '        "mcp__t3_code__orchestrator_capabilities",',
      "kept",
    ],
    [
      "packages/provider-pi/src/server/mcpExtensionSource.ts",
      '    const prefixes = ok ? ["mcp__t3-code__", "mcp__t3_code__"] : ["mcp__t3-code__"];',
      "agent-facing",
    ],
    [
      "apps/server/src/orchestration-v2/testkit/fixtures/x/codex_transcript.ndjson",
      '{"frame":{"params":{"clientInfo":{"name":"T3 Code","title":"T3 Code"}}}}',
      "wire-peer",
    ],
    [
      "apps/server/src/orchestration-v2/testkit/fixtures/x/codex_transcript.ndjson",
      '{"frame":{"params":{"clientInfo":{"name":"x"},"text":"You are running in T3 Code"}}}',
      "display",
    ],
    ["apps/web/src/lib/syntaxThemes.test.ts", '.toBe("t3-ember-light");', "identifier"],
    [
      "packages/ssh/src/tunnel.test.ts",
      'assert.include(launch, "mirror https://mirror.example/t3");',
      "identifier",
    ],
    [
      "packages/client-runtime/src/a.test.ts",
      'identity("github.com/me/t3code"),',
      "upstream-reference",
    ],
    [
      "apps/server/src/git/GitManager.test.ts",
      '            "binbandit/t3code": {',
      "upstream-reference",
    ],
    [
      "apps/web/src/a.test.ts",
      "git clone https://bitbucket.org/maria/t3code.git",
      "upstream-reference",
    ],
    [
      "apps/server/src/a.test.ts",
      "remote add origin git@github.com:julius/t3code.git",
      "upstream-reference",
    ],
    ["apps/web/src/a.test.ts", 'const root = "/Users/me/t3code";', "upstream-reference"],
    [
      "packaging/aur/t3code-bin/PKGBUILD",
      "MimeType=x-scheme-handler/t3code;",
      "upstream-reference",
    ],
    [
      "packages/shared/src/git.test.ts",
      '  it.each(["t3code", "t3code/"])("joins static prefix", () => {',
      "upstream-reference",
    ],
    ["packages/ssh/src/tunnel.test.ts", '    "exec "$T3_RUNTIME_DIR/lathe"",', "identifier"],
    [
      "packages/ssh/src/tunnel.test.ts",
      "      `tar -czf '${release}/t3-${archiveVersion}-${asset}'`,",
      "kept",
    ],
    [
      "scripts/build-desktop-artifact.test.ts",
      "              `release/t3-${backend}-snap-shot`,",
      "kept",
    ],
    [
      "scripts/build-desktop-artifact.test.ts",
      '      parseWslRuntimeArchiveMembers("./t3-1.2.3-linux-x64/t3\\r\\nt3-1.2.3-linux-x64/client/"),',
      "kept",
    ],
    [
      "packages/shared/src/providerAuthReturnUrl.test.ts",
      '    "t3code://app/welcome",',
      "upstream-reference",
    ],
    [
      "packages/client-runtime/src/promptLinks.test.ts",
      'findPromptLinkProject(projects, { owner: "me", name: "t3code" })',
      "upstream-reference",
    ],
    // Names upstream added after 337c5858c3.
    ["patches/@cursor__sdk@1.4.2.patch", "+var __t3m=__t3models.find(x)", "kept"],
    ["patches/@cursor__sdk@1.4.2.patch", " var T30,Y71;", "kept"],
    ["scripts/scenarios/a.e2e.ts", 'import { test, WEB } from "./t3.ts";', "identifier"],
    ["scripts/scenarios/a.e2e.ts", 'git("branch", "--list", "t3/*")', "identifier"],
    [
      "scripts/prove-scenario.ts",
      '  return source.includes("t3-mobile") ? "ios" : "web";',
      "identifier",
    ],
    ["scripts/e2e.config.ts", '        session: "t3-scenarios",', "identifier"],
    [
      "apps/desktop/src/preview/LoopbackTunnel.test.ts",
      '      refused ? { "x-t3-tunnel-port-refused": "1" } : {},',
      "wire-peer",
    ],
    ["apps/web/src/versionSkew.test.ts", '        kind: "t3-launcher",', "wire-peer"],
    [
      "packages/shared/src/mcpApp.ts",
      'export const MCP_APP_COLOR_SCHEME_PARAM = "t3-color-scheme";',
      "wire-peer",
    ],
    [
      "apps/server/src/mcp/McpInvocationContext.ts",
      'export const SENDER_THREAD_HEADER = "t3-sender-thread";',
      "wire-peer",
    ],
    [
      "apps/server/src/git/GitManager.ts",
      "const key = (branch: string) => `branch.${branch}.t3-pull-request`;",
      "kept",
    ],
    [
      "apps/server/src/vcs/GitVcsDriver.ts",
      'const HEAD_MARK_TRAILER = "T3-Head-Moved-At";',
      "kept",
    ],
    [
      "apps/server/src/provider/providerMaintenanceCommandCoordinator.ts",
      'const lockDirectory = () => NodePath.join(NodeOS.tmpdir(), "t3code-provider-updates");',
      "kept",
    ],
    [
      "apps/server/integration/TransferBudgetV2Fixture.integration.ts",
      '  canonicalKey: "github.com/t3/transfer-budget",',
      "kept",
    ],
    [
      "apps/web/src/components/issue/issueSavedViews.ts",
      '  storageKey: "t3.issues.savedViews",',
      "persisted",
    ],
    [
      "packages/shared/src/htmlRender.ts",
      'const CONTAIN_SCROLL_FRAGMENT_KEY = "t3-contain-scroll";',
      "kept",
    ],
    ["scripts/install.ps1", "  -match '^[^\\\\/]+\\\\t3\\.exe$'", "kept"],
    [
      "apps/server/src/mcp/toolkits/theme/tools.ts",
      'const ThemeReadTool = Tool.make("t3_theme_read", {',
      "agent-facing",
    ],
    [
      "packages/provider-acp/src/server/runtimeModel.ts",
      "      /^editor_t3_?code_[0-9a-f]{8}$/.test(qualified[1]) &&",
      "agent-facing",
    ],
    [
      "packages/provider-acp/src/server/runtimeModel.ts",
      "      /^editor_(?:lathe|t3_?code)_[0-9a-f]{8}$/.test(qualified[1]) &&",
      "kept",
    ],
    [
      "apps/web/src/components/mcp/mcpApps.ts",
      "        `hermes mcp add t3code --url ${url} --auth oauth`,",
      "agent-facing",
    ],
    [
      "apps/web/src/i18n/translations/en.json",
      '  "dac3e3eb509de945": "Run hermes mcp login t3code.",',
      "agent-facing",
    ],
    ["apps/server/scripts/dev-replay-agent.ts", 'const MCP_CALL = "t3/mcp_call";', "identifier"],
    [
      "apps/desktop/src/preview/BrowserSession.ts",
      'const CERTIFICATE_APPROVALS_FILE = "t3code-certificate-approvals.json";',
      "identifier",
    ],
    [
      "apps/desktop/src/shell/DesktopShellEnvironment.ts",
      "        !/^\\/tmp\\/\\.mount_T3-[^/]+(?:\\/|$)/u.test(entry),",
      "identifier",
    ],
    ["scripts/install.sh", "version_t3() {", "identifier"],
    [
      "apps/web/src/speech/pcmWorklet.ts",
      'registerProcessor("t3-pcm-capture", PcmCaptureProcessor);',
      "identifier",
    ],
    ["apps/server/src/vcs/GitVcsDriverCore.ts", '  prefix: "tmp_objdir-t3code-",', "identifier"],
    [
      "packages/provider-core/src/server/mcpSession.ts",
      'export const MCP_TOOL_EXPOSURE_HEADER = "t3-tool-exposure";',
      "identifier",
    ],
    ["scripts/install.sh", 'launcher_tmp="$(mktemp "${bin_dir}/.t3.XXXXXX")"', "identifier"],
    [
      "apps/server/src/project/ProjectSetupScriptRunner.ts",
      '  "let __t3c = $env.LAST_EXIT_CODE",',
      "identifier",
    ],
    [
      "apps/server/src/cli/uninstall.ts",
      "yield* Console.log(`Left ${launcher}: it no longer runs this t3.`);",
      "display",
    ],
    [
      "apps/web/src/i18n/translations/de.json",
      '  "26f98026953e6835": "{host} ist nicht mit deinem T3-Connect-Konto verknüpft",',
      "upstream-reference",
    ],
    [
      "apps/web/src/i18n/translations/de.json",
      '  "43c211068ab48950": "Hol dir mehr Tunnel mit deinem T3-Chat-Abo (sorry!)",',
      "upstream-reference",
    ],
    [
      "apps/web/src/i18n/translations/de.json",
      '  "0a7ec36662b6eff7": "T3-Thread gestartet",',
      "display",
    ],
    [
      "apps/web/src/i18n/translations/sv.json",
      '  "2b067fba95e3312b": "T3:s systemavtryck",',
      "display",
    ],
    ["apps/web/src/i18n/translations/ko.json", '  "0767c794edea8f03": "t3 명령",', "display"],
    [
      "packages/client-runtime/src/work-log/t3ToolSentences.ts",
      '    "Create\\nCreating\\nCreated\\nT3 threads",',
      "display",
    ],
    [
      "apps/server/src/cli/invocation.ts",
      "const PINNED_RUNTIME_ENTRY = /^(.*)\\/runtime\\/versions\\/[^/]+\\/t3$/;",
      "upstream-reference",
    ],
  ])("classifies %s: %s as %s", (path, line, expected) => {
    expect(classOf(path, line)).toBe(expected);
  });

  it("keeps a repository name whose owner sits on the line before", () => {
    const text = '  owner: "pingdotgg",\n  repo: "t3code",\n';
    const hit = findRenameOccurrences("scripts/build-desktop-artifact.test.ts", text)[0];
    if (!hit) throw new Error("no hit");
    expect(classifyRenameOccurrence(FORK_RENAME_RULES, hit)?.class).toBe("upstream-reference");
  });

  it("leaves a name no rule knows unclassified, so the rename stops", () => {
    expect(classOf("apps/server/src/x.ts", 'const NEW_NAME = "t3wombat";')).toBe("unclassified");
  });

  it("gives every rule a distinct id", () => {
    const ids = FORK_RENAME_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
