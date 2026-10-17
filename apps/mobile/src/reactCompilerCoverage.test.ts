// @effect-diagnostics nodeBuiltinImport:off - compiles real source files on disk.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const mobileRoot = NodePath.resolve(__dirname, "..");
const requireFromMobile = NodeModule.createRequire(NodePath.join(mobileRoot, "package.json"));
const babel: {
  transformFileSync: (file: string, options: Record<string, unknown>) => unknown;
} = requireFromMobile("@babel/core");
const metroConfig: Promise<{ transformer: { babelTransformerPath: string } }> =
  requireFromMobile("./metro.config.js");

// Files the compiler skips today. A skipped file still ships, just unmemoized.
// This list only shrinks: the test fails when a file here starts compiling, so
// delete its entry (and its manual useMemo/useCallback/memo) in the same change.
const KNOWN_BAILOUTS: Record<string, string> = {
  "src/components/ComposerAttachmentStrip.tsx": "unsupported syntax",
  "src/components/ComposerContextAttachment.tsx":
    "throw inside try, try without catch, try/finally",
  "src/components/ComposerEditor.tsx": "try/finally",
  "src/components/VideoPreviewModal.ios.tsx": "try without catch",
  "src/components/VideoPreviewModal.tsx": "ref read during render",
  "src/components/ui/AndroidAnchoredMenu.tsx": "ref read during render",
  "src/components/ui/Menu.tsx": "ref read during render",
  "src/components/ui/OverlayPortal.tsx": "unsupported syntax",
  "src/features/connection/ConnectionsNewRouteScreen.tsx": "try without catch",
  "src/features/devices/DevicePreviewRouteScreen.tsx": "try without catch",
  "src/features/diffs/nativeReviewDiffSurface.ts": "ref read during render",
  "src/features/files/AttachmentFileScreen.tsx": "manual memo not preserved",
  "src/features/files/FileMarkdownPreview.tsx": "try without catch",
  "src/features/files/FileTreeBrowser.tsx": "ref read during render",
  "src/features/files/SourceFileSurface.tsx": "try without catch",
  "src/features/files/ThreadFilesRouteScreen.tsx": "manual memo not preserved",
  "src/features/files/useFileTreeEntries.ts": "manual memo not preserved",
  "src/features/home/HomeScreen.tsx": "ref read during render",
  "src/features/home/WorkspaceConnectionTitle.tsx": "ref read during render",
  "src/features/home/home-list-options.ts": "manual memo not preserved",
  "src/features/home/thread-swipe-actions.tsx": "ref read during render",
  "src/features/home/useThreadListActions.ts": "try without catch",
  "src/features/layout/AdaptiveWorkspaceLayout.tsx": "ref read during render",
  "src/features/layout/workspace-inspector-pane.tsx": "mutates a frozen value",
  "src/features/layout/workspace-pane-divider.tsx": "ref read during render",
  "src/features/projects/AddProjectScreen.tsx": "try without catch",
  "src/features/pull-requests/PullRequestDiscussionScreen.tsx": "try/finally",
  "src/features/pull-requests/PullRequestInlineCommentScreen.tsx": "try without catch",
  "src/features/pull-requests/PullRequestMergeControls.tsx": "throw inside try, try/finally",
  "src/features/pull-requests/PullRequestReviewSheet.tsx": "try/finally",
  "src/features/pull-requests/PullRequestReviewersScreen.tsx": "throw inside try, try/finally",
  "src/features/pull-requests/PullRequestRouteScreen.tsx": "manual memo not preserved",
  "src/features/pull-requests/guide/PullRequestGuideScreen.tsx": "conditional inside try",
  "src/features/pull-requests/guide/ReviewGuideExcerpt.tsx": "conditional inside try",
  "src/features/pull-requests/guide/useReviewGuide.ts": "try without catch",
  "src/features/pull-requests/usePullRequestAction.ts": "throw inside try, try/finally",
  "src/features/pull-requests/usePullRequestListActions.ts": "throw inside try, try/finally",
  "src/features/pull-requests/usePullRequestListControls.ts": "unsupported syntax",
  "src/features/pull-requests/usePullRequestThreads.ts": "throw inside try, try/finally",
  "src/features/review/ReviewSheet.tsx": "try without catch",
  "src/features/review/reviewDiffRendering.tsx": "mutates a frozen value",
  "src/features/review/useNativeReviewDiffHighlighting.ts": "conditional inside try",
  "src/features/settings/SettingsAboutRouteScreen.tsx": "try without catch",
  "src/features/settings/SettingsAuthRouteScreen.tsx": "ref read during render",
  "src/features/settings/SettingsEnvironmentDetailRouteScreen.tsx":
    "try without catch, try/finally",
  "src/features/settings/SettingsEnvironmentsRouteScreen.tsx": "try without catch",
  "src/features/settings/SettingsNotificationsRouteScreen.tsx": "try without catch",
  "src/features/settings/SettingsProjectOverviewRouteScreen.tsx": "try without catch",
  "src/features/settings/SettingsProviderAccountsRouteScreen.tsx": "conditional inside try",
  "src/features/settings/SettingsScheduledTasksRouteScreen.tsx": "unsupported syntax",
  "src/features/settings/components/SettingsDragHandle.tsx": "ref read during render",
  "src/features/terminal/ThreadTerminalRouteScreen.tsx": "ref read during render",
  "src/features/threads/NewTaskContextPickerScreens.tsx":
    "manual memo not preserved, try without catch",
  "src/features/threads/NewTaskDraftScreen.tsx": "try/finally",
  "src/features/threads/NewTaskRouteScreen.tsx": "try without catch",
  "src/features/threads/PendingUserInputCard.tsx": "mutates a frozen value",
  "src/features/threads/QuestionAttachments.tsx": "try/finally",
  "src/features/threads/ThreadArrangementSheet.tsx": "ref read during render",
  "src/features/threads/ThreadComposer.tsx": "try without catch",
  "src/features/threads/ThreadDetailScreen.tsx": "mutates a frozen value",
  "src/features/threads/ThreadFeed.tsx": "ref read during render, throw inside try, try/finally",
  "src/features/threads/ThreadGitControls.tsx": "manual memo not preserved",
  "src/features/threads/ThreadNavigationSidebar.tsx": "ref read during render",
  "src/features/threads/ThreadQueueControl.tsx": "ref read during render, try without catch",
  "src/features/threads/ThreadRouteScreen.tsx": "try without catch",
  "src/features/threads/ThreadSettingsSheet.tsx": "manual memo not preserved, try without catch",
  "src/features/threads/UsageLimitRecoveryCard.tsx": "throw inside try, try/finally",
  "src/features/threads/git/GitCommitSheet.tsx": "manual memo not preserved",
  "src/features/threads/git/GitOverviewSheet.tsx": "try without catch",
  "src/features/threads/new-task-flow-provider.tsx": "try without catch",
  "src/features/threads/thread-work-log.tsx": "manual memo not preserved",
  "src/features/threads/use-composer-command-menu.ts": "manual memo not preserved",
  "src/features/threads/use-thread-list-v2-shelf-preferences.ts": "ref read during render",
  "src/features/voice-input/VoiceInputProvider.tsx": "ref read during render",
  "src/features/voice-input/useVoiceInputController.ts": "ref read during render",
  "src/lib/attachmentDocument.ts": "try/finally",
  "src/native/StackHeader.tsx": "ref read during render",
  "src/native/T3ComposerEditor.ios.tsx": "ref read during render",
  "src/native/T3ComposerEditor.native.tsx": "ref read during render",
  "src/state/composer-attachment-uploads.ts": "try without catch",
  "src/state/mediaActions.ts": "try without catch",
  "src/state/queries.ts": "manual memo not preserved",
  "src/state/use-thread-composer-state.ts": "try without catch",
  "src/state/use-thread-selection.ts": "ref read during render",
  "src/state/use-vcs-action-state.ts": "manual memo not preserved",
};

// Caller flags Metro passes for an iOS release bundle. supportsReactCompiler is
// what `experiments.reactCompiler` in app.config.ts turns on.
const metroCaller = {
  name: "metro",
  bundler: "metro",
  platform: "ios",
  isDev: false,
  isServer: false,
  isNodeModule: false,
  supportsStaticESM: true,
  supportsReactCompiler: true,
};

const sourceFiles = NodeFS.readdirSync(NodePath.join(mobileRoot, "src"), { recursive: true })
  .map(String)
  .filter((file) => /\.tsx?$/.test(file) && !/\.(test\.tsx?|d\.ts)$/.test(file))
  .map((file) => `src/${file.split(NodePath.sep).join("/")}`)
  .sort();

type CompilerLoc = { readonly start?: { readonly line?: number } } | null;

interface CompilerEvent {
  readonly kind: string;
  readonly detail?: {
    readonly options?: {
      readonly category?: string;
      readonly reason?: string;
      readonly loc?: CompilerLoc;
      readonly details?: readonly { readonly loc?: CompilerLoc }[];
    };
  };
}

// babel.config.js is the file Metro loads; the logger rides on the preset's
// own react-compiler option so the plugin runs with Metro's exact settings.
function compilerBailouts(file: string): string[] {
  const events: CompilerEvent[] = [];
  const babelConfig = requireFromMobile("./babel.config.js")({ cache: () => {} });
  const presets = babelConfig.presets.map(([name, options]: [string, object]) =>
    name === "babel-preset-expo"
      ? [
          requireFromMobile.resolve(name),
          {
            ...options,
            "react-compiler": {
              logger: { logEvent: (_: string, event: CompilerEvent) => events.push(event) },
            },
          },
        ]
      : [name, options],
  );
  babel.transformFileSync(NodePath.join(mobileRoot, file), {
    babelrc: false,
    configFile: false,
    cwd: mobileRoot,
    presets,
    caller: metroCaller,
    code: false,
  });
  return events
    .filter((event) => event.kind === "CompileError" || event.kind === "CompileSkip")
    .map(
      (event) =>
        `line ${(event.detail?.options?.loc ?? event.detail?.options?.details?.[0]?.loc)?.start?.line ?? "?"}: ${event.detail?.options?.category ?? event.kind} ${event.detail?.options?.reason ?? ""}`,
    );
}

describe("React Compiler coverage", () => {
  it("Metro's transformer applies the compiler", async () => {
    const { transformer } = await metroConfig;
    const metroTransformer = requireFromMobile(transformer.babelTransformerPath);
    const filename = NodePath.join(
      mobileRoot,
      "src/features/archive/ArchivedThreadsRouteScreen.tsx",
    );
    const transformed = (reactCompiler: string) => {
      const { ast } = metroTransformer.transform({
        filename,
        src: NodeFS.readFileSync(filename, "utf8"),
        plugins: [],
        options: {
          dev: false,
          hot: false,
          platform: "ios",
          projectRoot: mobileRoot,
          type: "module",
          enableBabelRCLookup: false,
          experimentalImportSupport: false,
          customTransformOptions: { reactCompiler, routerRoot: "app" },
        },
      });
      return JSON.stringify(ast.program.body);
    };
    expect(transformed("true")).toContain("react/compiler-runtime");
    expect(transformed("false")).not.toContain("react/compiler-runtime");
  });

  it("app.config.ts turns the compiler on for Metro", () => {
    const appConfig = NodeFS.readFileSync(NodePath.join(mobileRoot, "app.config.ts"), "utf8");
    expect(appConfig).toMatch(/experiments:\s*\{[^}]*reactCompiler:\s*true/);
  });

  it.each(sourceFiles)("compiles %s", (file) => {
    const bailouts = compilerBailouts(file);
    if (file in KNOWN_BAILOUTS) {
      expect(bailouts, `${file} compiles now; remove it from KNOWN_BAILOUTS`).not.toEqual([]);
    } else {
      expect(bailouts).toEqual([]);
    }
  });

  it("lists only files that exist", () => {
    expect(Object.keys(KNOWN_BAILOUTS).filter((file) => !sourceFiles.includes(file))).toEqual([]);
  });
}, 300_000);
