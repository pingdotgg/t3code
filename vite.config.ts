// @effect-diagnostics nodeBuiltinImport:off - Config load checks the debt-ceiling files exist before any Effect runtime exists.
import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { remoteCacheUrl } from "./infra/task-cache/src/remoteCache.ts";
import { cachedTestTasks } from "./scripts/lib/cached-tests.ts";

const TEST_EXCLUDE = [
  "**/.repos/**",
  "**/.t3/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/dist-electron/**",
  "**/.{idea,git,cache,output,temp}/**",
];

// Directories whose tests belong to a package's own test config. desktop also
// owns the kde-snap-shot tests through its `include`.
const TEST_CONFIG_PACKAGES = [
  "apps/desktop",
  "apps/mobile",
  "apps/server",
  "apps/web",
  "packages/client-runtime",
];

// `vp test run <file>` from the repo root hands each file to its package's
// config. Packages that borrow this config (`--config ../../vite.config.ts`) run
// from their own directory, as CI does, so they keep one plain project.
const isRepoRootTestRun = process.cwd() === import.meta.dirname;

/** Debt ceilings for files that still exist, so a branch deleting a file can't break the config. */
const existingCeilings = (ceilings: Record<string, number>) =>
  Object.entries(ceilings).filter(([file]) =>
    NodeFS.existsSync(NodeURL.fileURLToPath(new URL(file, import.meta.url))),
  );

const RESTRICTED_IMPORT_PATHS = [
  {
    name: "@t3tools/client-runtime",
    message:
      "Import from an explicit @t3tools/client-runtime/* subpath. The package has no root export.",
  },
  {
    name: "@pierre/diffs/react",
    importNames: ["CodeView"],
    message: "Use StyledDiffCodeView so web diff surfaces share styling and virtualized geometry.",
  },
  {
    name: "react-native-screens",
    importNames: ["ScrollViewMarker"],
    message:
      "Use NativeScrollViewMarker or NativeScrollView (src/native/NativeScrollViewMarker.tsx): they carry the header's scroll-edge blur under the Duo's vertical bar.",
  },
];

const RESTRICTED_UI_VARIANT_PATTERNS = [
  {
    group: ["**/components/ui/*", "**/ui/*", "./ui/*"],
    importNames: ["buttonVariants", "toggleVariants", "badgeVariants", "selectTriggerVariants"],
    message:
      "Render the components/ui export instead of borrowing its class recipe (render={<Button …/>}, SelectButton, ToggleGroup).",
  },
];

const RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS = {
  name: "lucide-react",
  importNames: [
    "GitMerge",
    "GitMergeIcon",
    "GitPullRequest",
    "GitPullRequestIcon",
    "GitPullRequestArrow",
    "GitPullRequestArrowIcon",
    "GitPullRequestClosed",
    "GitPullRequestClosedIcon",
    "GitPullRequestDraft",
    "GitPullRequestDraftIcon",
    "GitPullRequestCreate",
    "GitPullRequestCreateIcon",
    "GitPullRequestCreateArrow",
    "GitPullRequestCreateArrowIcon",
  ],
  message:
    "Pick a glyph by meaning from PullRequestGlyph in apps/web/src/components/pullRequest/pullRequestIcons.tsx so every surface draws the same pull request the same way.",
};

// Vite+ supports remote configuration before its published types include it.
const cacheUrl = remoteCacheUrl(import.meta.dirname);
const taskCacheConfig = {
  scripts: false,
  ...(cacheUrl ? { remote: { url: cacheUrl } } : {}),
};

export default defineConfig({
  run: {
    cache: taskCacheConfig,
    tasks: cachedTestTasks(process.env.T3_CACHED_TESTS),
  },
  resolve: {
    alias: {
      "~": NodeURL.fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Fixture subprocesses must not inherit the outer task runner’s cache policy.
    env: { VP_REMOTE_CACHE: "off", VP_REMOTE_CACHE_URL: "" },
    exclude: TEST_EXCLUDE,
    hookTimeout: 60_000,
    testTimeout: 60_000,
    allowOnly: !process.env.CI,
    // Flaky tests are fixed, not retried.
    retry: 0,
    fakeTimers: {
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "setImmediate",
        "clearImmediate",
        "Date",
        "performance",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "requestIdleCallback",
        "cancelIdleCallback",
      ],
    },
    setupFiles: [
      NodeURL.fileURLToPath(
        new URL("./packages/shared/src/testing/longTempDir.ts", import.meta.url),
      ),
      NodeURL.fileURLToPath(
        new URL("./packages/shared/src/testing/providerEnv.ts", import.meta.url),
      ),
    ],
    ...(isRepoRootTestRun
      ? {
          projects: [
            ...TEST_CONFIG_PACKAGES,
            {
              extends: true,
              test: {
                name: "root",
                exclude: [
                  ...TEST_EXCLUDE,
                  ...TEST_CONFIG_PACKAGES.map((dir) => `${dir}/**`),
                  "native/kde-snap-shot/**",
                ],
              },
            },
          ],
        }
      : {}),
  },
  staged: {
    // In order, so lint reads the formatted file. CI lint failures cost a full round trip.
    "*": ["vp fmt --no-error-on-unmatched-pattern", "vp lint --no-error-on-unmatched-pattern"],
    // knip checks the whole repo, so it takes no file list. Any code or manifest change can leave
    // a file, export, or dependency unused.
    "{*.{js,jsx,ts,tsx,mjs,cjs,mts,cts},package.json,knip.jsonc}": () => "vp run knip:check",
  },
  fmt: {
    ignorePatterns: [
      ".repos/**",
      "infra/task-cache/vendor/**",
      // Macroscope requires one glob per line; Markdown formatting corrupts it.
      ".macroscope/ignore.md",
      ".alchemy",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "**/*.graphql.ts",
      "packages/source-control-github/schema/**",
      "apps/server/schema/**",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/mobile/uniwind-types.d.ts",
      // Vendored and generated C.
      "apps/mobile/modules/t3-highlights/Vendor/**",
      "apps/mobile/modules/t3-highlights/cpp/generated/**",
      "*.icon/**",
    ],
    sortPackageJson: {},
    overrides: [
      {
        files: [".devcontainer/devcontainer.json"],
        options: {
          trailingComma: "none",
        },
      },
    ],
  },
  lint: {
    ignorePatterns: [
      ".repos",
      ".repos/**",
      "infra/task-cache/vendor/**",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "**/*.graphql.ts",
      "packages/source-control-github/schema/**",
      "apps/server/schema/**",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/mobile/uniwind-types.d.ts",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./oxlint-plugin-t3code/index.ts", "@shadcn/lint"],
    settings: {
      shadcn: { ui: "~/components/ui" },
    },
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "oxc/no-accumulating-spread": "error",
      "eslint/no-control-regex": "off",
      "typescript/no-this-alias": "off",
      "unicorn/prefer-add-event-listener": "off",
      "unicorn/prefer-string-starts-ends-with": "off",
      "unicorn/prefer-set-has": "off",
      "unicorn/prefer-array-find": "off",
      "unicorn/no-new-array": "off",
      "unicorn/no-array-reverse": "off",
      "react/no-object-type-as-default-prop": "off",
      "react/jsx-no-constructed-context-values": "off",
      "react/memo-dependencies": "error",
      "react/purity": "error",
      "react/refs": "error",
      "react/exhaustive-effect-dependencies": "error",
      "react/set-state-in-effect": "error",
      "react/immutability": "error",
      "react/no-array-index-key": "error",
      "react/no-unstable-nested-components": "error",
      "react/static-components": "error",
      "react/capitalized-calls": "error",
      "typescript/no-extraneous-class": "error",
      "eslint/no-empty-pattern": "error",
      "eslint/no-new": "error",
      "unicorn/no-useless-spread": "error",
      "eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "eslint/no-unsafe-optional-chaining": "error",
      "eslint/no-unneeded-ternary": "error",
      "unicorn/no-useless-fallback-in-spread": "error",
      "unicorn/require-module-specifiers": "error",
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "oxc/no-map-spread": "off",
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "typescript/consistent-return": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-duplicate-type-constituents": "off",
      "typescript/no-floating-promises": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/await-thenable": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "eslint/no-restricted-imports": [
        "error",
        { paths: [...RESTRICTED_IMPORT_PATHS, RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS] },
      ],
      "t3code/no-global-process-runtime": "error",
      "t3code/no-inline-schema-compile": "error",
      "t3code/no-low-value-comments": "error",
      "t3code/no-manual-effect-runtime-in-tests": "error",
      "t3code/no-native-title-tooltip": "error",
      // Test files only (the rule checks the filename).
      "t3code/no-polling-loop-in-tests": "error",
      "t3code/no-raw-mcp-registration": "error",
      "t3code/no-real-time-wait-in-tests": "error",
      "t3code/no-test-in-loop": "error",
      "t3code/no-test-timeout-or-unreasoned-skip": "error",
      "t3code/no-rpc-permission-bypass": ["error", { allowRawClientAccess: true }],
      "t3code/no-unscoped-has": "error",
      "t3code/no-wall-clock-in-tests": "error",
      "t3code/namespace-node-imports": "error",
      "t3code/prefer-catch-tags": "error",
      "t3code/prefer-effect-fn": "error",
      "t3code/require-centered-scroll-gutter": "error",
      "t3code/require-suppression-reason": "error",
    },
    overrides: [
      {
        files: [
          "**/*.{test,spec,testkit}.{ts,tsx}",
          "**/{test,tests,testkit,testing,fixtures,integration}/**",
          "packages/provider-testing/**",
        ],
        rules: { "t3code/prefer-effect-fn": "off" },
      },
      {
        files: ["apps/web/**/*.test.{ts,tsx}"],
        rules: { "t3code/require-disposable-render": "error" },
      },
      {
        files: ["apps/web/src/**/*.browser.test.{ts,tsx}"],
        rules: { "t3code/no-frame-waits-in-browser-tests": "error" },
      },
      {
        files: ["apps/**/src/**", "packages/**/src/**"],
        rules: { "t3code/no-dom-test-environment": "error" },
      },
      {
        files: ["apps/web/src/**", "apps/mobile/src/**"],
        rules: { "t3code/no-spaced-caps": "error" },
      },
      {
        // A <button>, <a> or <input> with appearance classes is a hand-built control that
        // skips the components/ui variants; shadcn/no-restyle cannot see it because it only
        // checks ui components. components/ui builds the primitives from raw elements.
        files: ["apps/web/src/**"],
        excludeFiles: ["apps/web/src/components/ui/**"],
        rules: { "t3code/no-styled-raw-controls": "error" },
      },
      {
        // Type comes from the seven roles (text-title … text-micro, or <Text>), not
        // Tailwind's size and weight scale. components/ui defines the roles' users,
        // tests assert on markup, and the catalog demos raw classes on purpose.
        files: ["apps/web/src/**"],
        excludeFiles: [
          "apps/web/src/components/ui/**",
          "apps/web/src/components/design-system/**",
          "apps/web/src/**/*.test.{ts,tsx}",
        ],
        rules: { "t3code/no-raw-type-classes": "error" },
      },
      {
        files: ["packages/client-runtime/src/state/**", "apps/{web,mobile,desktop}/src/**"],
        rules: { "t3code/no-rpc-permission-bypass": ["error", { allowRawClientAccess: false }] },
      },
      {
        files: [
          "packages/client-runtime/src/state/runtime.ts",
          "packages/client-runtime/src/state/vcsAction.ts",
        ],
        rules: {
          "t3code/no-rpc-permission-bypass": [
            "error",
            { allowGuardInstallation: true, allowRawClientAccess: false },
          ],
        },
      },
      {
        files: [
          "apps/web/src/components/settings/AuthorizedClientsSettings.tsx",
          "apps/mobile/src/features/updates/app-updates.ts",
          "apps/web/src/components/device/DevicePhoneViewport.tsx",
          "apps/web/src/components/device/DeviceDuoViewport.tsx",
        ],
        rules: { "t3code/no-rpc-permission-bypass": ["error", { allowRawClientAccess: true }] },
      },
      {
        files: ["packages/client-runtime/src/connection/outdatedHostUpdate.ts"],
        rules: { "t3code/no-rpc-permission-bypass": "off" },
      },
      {
        files: [
          "packages/client-runtime/src/rpc/**",
          "**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
        ],
        rules: { "t3code/no-rpc-permission-bypass": "off" },
      },
      {
        files: ["packages/shared/src/HostProcess.ts"],
        rules: { "t3code/no-global-process-runtime": "off" },
      },
      {
        // The `t3` npm launcher is published as plain, dependency-free Node.
        files: ["scripts/npm-launcher/**"],
        rules: {
          "t3code/no-global-process-runtime": "off",
          "t3code/namespace-node-imports": "off",
        },
      },
      {
        files: ["apps/server/src/mcp/McpHttpServer.ts"],
        rules: { "t3code/no-raw-mcp-registration": "off" },
      },
      {
        files: ["apps/web/src/**"],
        excludeFiles: ["apps/web/src/components/ui/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              paths: [...RESTRICTED_IMPORT_PATHS, RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS],
              patterns: RESTRICTED_UI_VARIANT_PATTERNS,
            },
          ],
        },
      },
      {
        files: ["apps/web/src/components/pullRequest/pullRequestIcons.tsx"],
        rules: { "eslint/no-restricted-imports": ["error", { paths: RESTRICTED_IMPORT_PATHS }] },
      },
      {
        // The server and every client load a forge's shared definition, so a UI runtime
        // imported there would break the server; client-only forge code goes in `src/client/`.
        files: ["packages/source-control-*/src/shared/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              paths: [...RESTRICTED_IMPORT_PATHS, RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS],
              patterns: [
                {
                  group: [
                    "react",
                    "react/*",
                    "react-*",
                    "expo",
                    "expo-*",
                    "lucide-react",
                    "@t3tools/client-runtime",
                    "@t3tools/client-runtime/*",
                    "../client/*",
                    "../server/*",
                    "../../client/*",
                    "../../server/*",
                    "../../../client/*",
                    "../../../server/*",
                    "@t3tools/source-control-*/client/*",
                    "@t3tools/source-control-*/server/*",
                  ],
                  message:
                    "Shared forge definitions load on the server and every client; keep UI and server code out.",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["apps/server/src/**", "packages/source-control-*/src/server/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              paths: [...RESTRICTED_IMPORT_PATHS, RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS],
              patterns: [
                {
                  group: [
                    "@t3tools/source-control-*/client/*",
                    "../client/*",
                    "../../client/*",
                    "../../../client/*",
                  ],
                  message:
                    "A forge's client entry is UI-only; the server reads its `shared/definition`.",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["apps/mobile/src/**"],
        rules: {
          "t3code/no-mobile-uniwind-theme-escape-hatches": "error",
          "t3code/require-registered-list-scroll": "error",
        },
      },
      {
        files: ["apps/mobile/src/**"],
        excludeFiles: [
          "apps/mobile/src/components/ui/AppSymbol.tsx",
          "apps/mobile/src/components/ui/AppSymbol.ios.tsx",
          "apps/mobile/src/features/pull-requests/pullRequestGlyphs.ts",
        ],
        rules: { "t3code/no-mobile-pull-request-glyph-literals": "error" },
      },
      {
        files: ["apps/mobile/src/**"],
        excludeFiles: ["**/*.test.{ts,tsx}"],
        rules: { "t3code/no-ambiguous-detail-navigation": "error" },
      },
      {
        // Raw ResizeObserver state commits miss the paint; observeResize flushes derived layout together.
        files: ["apps/web/src/**"],
        excludeFiles: [
          "apps/web/src/lib/observeResize.ts",
          "**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
        ],
        rules: { "t3code/no-raw-resize-observer": "error" },
      },
      {
        files: ["apps/web/src/**"],
        rules: { "shadcn/no-unknown-classes": "error" },
      },
      {
        files: ["apps/web/src/**"],
        rules: { "t3code/no-outset-state-indicators": "error" },
      },
      {
        files: ["apps/*/src/**", "packages/*/src/**"],
        excludeFiles: [
          "**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
          "**/testkit/**",
          "**/_generated/**",
          // Real user quotes stay verbatim.
          "apps/marketing/src/lib/tweets.ts",
        ],
        rules: { "t3code/no-em-dash-copy": "error" },
      },
      {
        files: ["apps/web/src/**"],
        rules: { "shadcn/no-raw-colors": "error" },
      },
      {
        // Third-party marks must retain their exact colors.
        files: ["apps/web/src/components/Icons.tsx", "apps/web/src/components/JetBrainsIcons.tsx"],
        rules: { "shadcn/no-raw-colors": "off" },
      },
      {
        files: ["apps/web/src/**"],
        excludeFiles: ["apps/web/src/components/ui/**"],
        rules: {
          "shadcn/require-static-classes": "error",
          "shadcn/no-arbitrary-values": [
            "error",
            {
              allow: [
                "layout",
                "transition",
                "rounded-[inherit]",
                "gap-[0.33em]",
                "gap-[0.2em]",
                "leading-[normal]",
                "underline-offset-[0.2em]",
                "rounded-[25%]",
                "text-[length:80cqh]",
                "bg-[Highlight]",
                "fill-[#26251E]",
                "fill-[#EDECEC]",
                "fill-[#0F0F0F]",
                "fill-[#F5F5F5]",
                "fill-[#d97757]",
                "text-[#d97757]",
              ],
            },
          ],
          "shadcn/no-restyle": [
            "error",
            {
              allow: ["layout"],
              contracts: [
                {
                  // CollapsibleTrigger has no styled counterpart; other triggers use render={<Button …/>}.
                  pattern: "^CollapsibleTrigger$",
                  allow: ["layout", "color", "typography", "spacing", "shape", "effects", "motion"],
                },
              ],
            },
          ],
        },
      },
      {
        // React Compiler owns memoization; upstream rules do not ban redundant useMemo/useCallback.
        files: ["apps/web/src/**/*.{ts,tsx}"],
        rules: {
          "react/exhaustive-effect-dependencies": "error",
          "react/globals": "error",
          "react/hooks": "error",
          "react/immutability": "error",
          // The compiler memoizes context values; this rule would ask for useMemo.
          "react/jsx-no-constructed-context-values": "off",
          "react/memo-dependencies": "error",
          "react/preserve-manual-memoization": "error",
          // Render-time clock reads use @t3tools/client-runtime/clock or state seeded with the
          // time; any other read carries a suppression that says why. oxlint also flags time reads
          // inside event handlers (oxc#27309); those suppressions cite it.
          "react/purity": "error",
          "react/refs": "error",
          "react/set-state-in-effect": "error",
          "react/set-state-in-render": "error",
          "react/static-components": "error",
          "react/unsupported-syntax": "error",
          "t3code/no-manual-memo": "error",
        },
      },
      {
        // ESNext types allow APIs absent from Hermes; restrict shared client code, exempting Node tests.
        files: [
          "apps/mobile/src/**",
          "packages/client-runtime/src/**",
          "packages/contracts/src/**",
          "packages/shared/src/**",
        ],
        excludeFiles: ["**/*.test.ts", "**/*.test.tsx"],
        rules: { "t3code/no-hermes-unsupported-apis": "error" },
      },
      {
        // Directives hide bailouts from mobile's compiler-coverage check; retain hooks until its allowlist is empty.
        files: ["apps/mobile/src/**/*.{ts,tsx}"],
        rules: { "t3code/no-manual-memo": ["error", { allowMemoHooks: true }] },
      },
      {
        files: ["apps/web/src/**", "apps/mobile/src/**", "packages/*/src/**"],
        rules: { "t3code/no-unreasoned-state-sync": "error" },
      },
      {
        // React Compiler caches use* functions only if they call a hook.
        files: ["apps/web/src/**/*.{ts,tsx}", "apps/mobile/src/**/*.{ts,tsx}"],
        excludeFiles: ["**/*.test.ts", "**/*.test.tsx"],
        rules: { "t3code/no-hookless-use-function": "error" },
      },
      {
        files: [
          "apps/mobile/src/features/archive/ArchivedThreadsScreen.tsx",
          "apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx",
          "apps/mobile/src/features/files/FileMarkdownPreview.tsx",
          "apps/mobile/src/features/files/SourceFileSurface.tsx",
          "apps/mobile/src/features/files/AttachmentFileScreen.tsx",
          "apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx",
          "apps/mobile/src/features/files/thread-file-navigator-pane.tsx",
          "apps/mobile/src/features/review/ReviewSheet.tsx",
          "apps/mobile/src/features/review/useNativeReviewDiffBridge.ts",
          "apps/mobile/src/features/settings/SettingsEnvironmentsRouteScreen.tsx",
          "apps/mobile/src/features/threads/ThreadComposer.tsx",
          "apps/mobile/src/features/threads/ThreadFeed.tsx",
          "apps/mobile/src/features/threads/ThreadQueueControl.tsx",
          "apps/mobile/src/features/review/ReviewCommentCard.tsx",
          "apps/mobile/src/features/threads/ThreadSettingsSheet.tsx",
          "apps/mobile/src/features/threads/thread-list-v2-items.tsx",
          "apps/mobile/src/lib/useMobileNavigationTheme.ts",
          "apps/mobile/src/native/T3ComposerEditor.ios.tsx",
          "apps/mobile/src/native/T3ComposerEditor.native.tsx",
          "apps/mobile/src/native/SelectableMarkdownText.tsx",
          "apps/mobile/src/native/useEnrichedLinkVariants.ts",
        ],
        rules: {
          "t3code/no-mobile-uniwind-theme-escape-hatches": ["error", { allowUniwindTheme: true }],
        },
      },
      // Hand-styled raw controls tracked as debt: no net-new occurrences. Lower a
      // ceiling when you replace one with a components/ui control; delete it at zero.
      // Never raise a ceiling or add a file to pass lint: render the ui control.
      ...existingCeilings({
        "apps/web/src/components/pullRequest/guide/GuideRail.tsx": 1,
        "apps/web/src/components/Sidebar.tsx": 1,
        "apps/web/src/components/sidebar/SidebarDraftBlock.tsx": 1,
        "apps/web/src/components/sidebar/SidebarThreadRow.tsx": 10,
        "apps/web/src/components/chat/MessagesTimeline.tsx": 3,
        "apps/web/src/components/chat/TimelineMinimap.tsx": 1,
        "apps/web/src/components/chat/TimelineUserMessageRow.tsx": 1,
        "apps/web/src/components/chat/TimelineV2EventRow.tsx": 1,
        "apps/web/src/components/chat/TimelineWorkEntryRow.tsx": 2,
        "apps/web/src/components/chat/TimelineWorkGroupRows.tsx": 1,
        "apps/web/src/components/chat/UserMessageContextChips.tsx": 1,
        "apps/web/src/components/chat/ChatComposer.tsx": 1,
        "apps/web/src/components/chat/ComposerAttachmentStrip.tsx": 3,
        "apps/web/src/components/chat/ComposerPrimaryActions.tsx": 3,
        "apps/web/src/components/settings/ThemeSettings.tsx": 5,
        "apps/web/src/components/settings/AddEnvironmentDialog.tsx": 1,
        "apps/web/src/components/settings/AuthorizedClientsSettings.tsx": 3,
        "apps/web/src/components/settings/ThemeColorPicker.tsx": 3,
        "apps/web/src/components/chat/ChatHeader.tsx": 2,
        "apps/web/src/components/pullRequest/PullRequestReactions.tsx": 3,
        "apps/web/src/components/RightPanelTabs.tsx": 3,
        "apps/web/src/components/settings/ProjectIconPickerDialog.tsx": 3,
        "apps/web/src/components/chat/ChangedFilesTree.tsx": 2,
        "apps/web/src/components/preview/PreviewRecentUrlCard.tsx": 2,
        "apps/web/src/components/pullRequest/PullRequestSummaryTab.tsx": 1,
        "apps/web/src/components/settings/AddProviderInstanceDialog.tsx": 2,
        "apps/web/src/components/sidebar/SidebarProviderUpdatePill.tsx": 2,
        "apps/web/src/components/ThreadTerminalDrawer.tsx": 2,
        "apps/web/src/components/chat/AssistantCitationCommentEditor.tsx": 1,
        "apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx": 1,
        "apps/web/src/components/chat/ComposerStashMenu.tsx": 1,
        "apps/web/src/components/chat/DraftHeroHeadline.tsx": 1,
        "apps/web/src/components/chat/TimelineSystemDivider.tsx": 1,
        "apps/web/src/components/chat/V2ItemInspector.tsx": 1,
        "apps/web/src/components/chat/V2LifecycleRow.tsx": 1,
        "apps/web/src/components/ChatMarkdown.tsx": 1,
        "apps/web/src/browser/BrowserViewportResizeHandles.tsx": 1,
        "apps/web/src/components/desktopUpdate.toast.tsx": 1,
        "apps/web/src/components/files/FileBreadcrumbs.tsx": 1,
        "apps/web/src/components/files/FileBrowserPanel.tsx": 1,
        "apps/web/src/components/media/MediaVideoPlayer.tsx": 1,
        "apps/web/src/components/projectScriptEditor.tsx": 1,
        "apps/web/src/components/pullRequest/PullRequestChecksPopover.tsx": 1,
        "apps/web/src/components/pullRequest/PullRequestCopyableCode.tsx": 1,
        "apps/web/src/components/pullRequest/PullRequestMarkdown.tsx": 1,
        "apps/web/src/components/pullRequest/PullRequestReviewAnnotation.tsx": 1,
        "apps/web/src/components/pullRequest/PullRequestRow.tsx": 1,
        "apps/web/src/components/pullRequest/PullRequestTimelineTab.tsx": 1,
        "apps/web/src/components/search/ProjectContentSearchDialog.tsx": 1,
        "apps/web/src/components/settings/BrowserImportWizard.tsx": 1,
        "apps/web/src/components/settings/CodexSetupSection.tsx": 1,
        "apps/web/src/components/settings/DeviceHostEditor.tsx": 1,
        "apps/web/src/components/settings/DiagnosticsSettings.tsx": 1,
        "apps/web/src/components/settings/KeybindingsSettings.tsx": 1,
        "apps/web/src/components/settings/PanelAnimationsPreview.tsx": 1,
        "apps/web/src/components/settings/ProviderInstanceCard.tsx": 1,
        "apps/web/src/components/settings/OpenSourceLicenses.tsx": 1,
        "apps/web/src/components/settings/RedactedSensitiveText.tsx": 1,
        "apps/web/src/components/settings/SettingInheritance.tsx": 1,
        "apps/web/src/components/settings/ThemeImportDialog.tsx": 1,
        "apps/web/src/components/settings/ThemePreviewCircles.tsx": 1,
        "apps/web/src/components/sidebar/SidebarUpdatePill.tsx": 1,
        "apps/web/src/components/sidebar/SidebarUpdateReleaseNotes.tsx": 1,
        "apps/web/src/components/ThreadStatusIndicators.tsx": 1,
        "apps/web/src/components/usage/UsageLimitsPooled.tsx": 1,
      }).map(([file, maxOccurrences]) => {
        const rule: ["error", { maxOccurrences: number }] = ["error", { maxOccurrences }];
        return { files: [file], rules: { "t3code/no-styled-raw-controls": rule } };
      }),
      // Raw type classes tracked as debt: no net-new occurrences. Lower a ceiling
      // when you move a file onto the type roles; delete its entry at zero.
      // Never raise a ceiling or add a file to pass lint: use <Text> or a role class.
      ...existingCeilings({
        "apps/web/src/components/settings/AboutVersionTitle.tsx": 1,
        "apps/web/src/components/chat/SideChatPane.tsx": 2,
        "apps/web/src/components/pullRequest/guide/GuideNotes.tsx": 7,
        "apps/web/src/components/pullRequest/guide/GuideRail.tsx": 4,
        "apps/web/src/components/settings/ResourceTelemetryDiagnostics.tsx": 58,
        "apps/web/src/components/chat/MessagesTimeline.tsx": 4,
        "apps/web/src/components/chat/TimelineAssistantRows.tsx": 3,
        "apps/web/src/components/chat/TimelineMinimap.tsx": 2,
        "apps/web/src/components/chat/TimelineRowParts.tsx": 1,
        "apps/web/src/components/chat/TimelineUserMessageRow.tsx": 2,
        "apps/web/src/components/chat/TimelineV2EventRow.tsx": 14,
        "apps/web/src/components/chat/TimelineWorkEntryRow.tsx": 7,
        "apps/web/src/components/chat/TimelineWorkGroupRows.tsx": 1,
        "apps/web/src/components/chat/UserMessageContextChips.tsx": 14,
        "apps/web/src/components/settings/DiagnosticsSettings.tsx": 15,
        "apps/web/src/components/settings/AuthorizedClientsSettings.tsx": 1,
        "apps/web/src/components/usage/UsagePage.tsx": 34,
        "apps/web/src/components/GitActionsControl.tsx": 1,
        "apps/web/src/components/Sidebar.tsx": 3,
        "apps/web/src/components/sidebar/SidebarDraftBlock.tsx": 2,
        "apps/web/src/components/sidebar/SidebarThreadRow.tsx": 20,
        "apps/web/src/components/sidebar/SidebarListMarkers.tsx": 2,
        "apps/web/src/components/pullRequest/PullRequestDetailPanel.tsx": 3,
        "apps/web/src/components/usage/UsageLimitsPooled.tsx": 25,
        "apps/web/src/components/settings/SettingsPanels.tsx": 3,
        "apps/web/src/components/settings/AppearanceSettingsPanel.tsx": 1,
        "apps/web/src/components/settings/BackgroundActivitySettings.tsx": 15,
        "apps/web/src/components/settings/TypographySettings.tsx": 1,
        "apps/web/src/components/pullRequest/PullRequestTimelineTab.tsx": 18,
        "apps/web/src/components/chat/ChatComposer.tsx": 1,
        "apps/web/src/components/chat/ComposerControlsBar.tsx": 1,
        "apps/web/src/components/chat/ComposerAttachmentStrip.tsx": 4,
        "apps/web/src/components/chat/ComposerFooterControls.tsx": 2,
        "apps/web/src/components/device/DeviceSetup.tsx": 14,
        "apps/web/src/components/pullRequest/PullRequestSummaryTab.tsx": 1,
        "apps/web/src/components/DiffPanel.tsx": 1,
        "apps/web/src/components/pullRequest/PullRequestGhosts.tsx": 4,
        "apps/web/src/components/settings/ProviderInstanceCard.tsx": 11,
        "apps/web/src/components/settings/AddProviderInstanceDialog.tsx": 11,
        "apps/web/src/components/settings/CodexSetupSection.tsx": 4,
        "apps/web/src/components/chat/V2LifecycleRow.tsx": 9,
        "apps/web/src/components/device/DeviceToolsPanel.tsx": 10,
        "apps/web/src/components/settings/KeybindingsSettings.tsx": 1,
        "apps/web/src/components/settings/OpenSourceLicenses.tsx": 1,
        "apps/web/src/components/settings/ThemeEditorPanel.tsx": 6,
        "apps/web/src/components/chat/ContextWindowMeter.tsx": 9,
        "apps/web/src/components/settings/CaptureShortcutConfig.tsx": 9,
        "apps/web/src/components/chat/WorktreeSetupCard.tsx": 1,
        "apps/web/src/components/ChatMarkdown.tsx": 4,
        "apps/web/src/components/chat/ChatMarkdownMedia.tsx": 2,
        "apps/web/src/components/chat/MarkdownCodeBlock.tsx": 1,
        "apps/web/src/components/chat/MarkdownDetails.tsx": 1,
        "apps/web/src/components/device/DevicePanel.tsx": 4,
        "apps/web/src/components/settings/BrowserImportWizard.tsx": 8,
        "apps/web/src/components/settings/ProviderModelsSection.tsx": 5,
        "apps/web/src/components/settings/ScheduledTasksSettings.tsx": 6,
        "apps/web/src/components/settings/SourceControlSettings.tsx": 2,
        "apps/web/src/components/projectScriptEditor.tsx": 2,
        "apps/web/src/components/pullRequest/PullRequestChecksPopover.tsx": 7,
        "apps/web/src/components/search/ProjectContentSearchDialog.tsx": 1,
        "apps/web/src/components/settings/CustomModelEditor.tsx": 7,
        "apps/web/src/components/settings/DeviceHostEditor.tsx": 7,
        "apps/web/src/components/settings/ThemeColorPicker.tsx": 6,
        "apps/web/src/components/settings/ThemeSettings.tsx": 7,
        "apps/web/src/components/usage/UsagePriceOverrides.tsx": 7,
        "apps/web/src/components/chat/ChangedFilesTree.tsx": 6,
        "apps/web/src/components/chat/SnapShotAttachmentDetails.tsx": 6,
        "apps/web/src/components/chat/TraitsPicker.tsx": 6,
        "apps/web/src/components/cloud/CloudEnvironmentConnectList.tsx": 6,
        "apps/web/src/components/CommandPalette.tsx": 1,
        "apps/web/src/components/CommandPaletteAddProject.tsx": 4,
        "apps/web/src/components/CommandPaletteThemeItems.tsx": 2,
        "apps/web/src/components/CommandPaletteResults.tsx": 6,
        "apps/web/src/components/pullRequest/PullRequestListFilters.tsx": 4,
        "apps/web/src/components/pullRequest/PullRequestListRow.tsx": 5,
        "apps/web/src/components/PullRequestThreadDialog.tsx": 6,
        "apps/web/src/components/settings/AcpSessionManagementSection.tsx": 6,
        "apps/web/src/components/settings/ProjectIconPickerDialog.tsx": 1,
        "apps/web/src/components/settings/SnapShotSetupDialog.tsx": 6,
        "apps/web/src/components/sidebar/SidebarUpdateReleaseNotes.tsx": 6,
        "apps/web/src/components/chat/V2ItemInspector.tsx": 2,
        "apps/web/src/components/device/DeviceToolVersions.tsx": 5,
        "apps/web/src/components/preview/PreviewEmptyState.tsx": 2,
        "apps/web/src/components/pullRequest/PullRequestReviewAnnotation.tsx": 1,
        "apps/web/src/components/RightPanelTabs.tsx": 2,
        "apps/web/src/components/settings/AcpRegistrySearchStep.tsx": 5,
        "apps/web/src/components/settings/ProviderAuthenticationSection.tsx": 5,
        "apps/web/src/components/settings/SettingInheritance.tsx": 1,
        "apps/web/src/components/chat/ComposerUsageLimits.tsx": 4,
        "apps/web/src/components/chat/TimelineOverlays.tsx": 1,
        "apps/web/src/components/composerContextPresentation.tsx": 4,
        "apps/web/src/components/contextChipParts.tsx": 4,
        "apps/web/src/components/files/AttachmentFilePreview.tsx": 4,
        "apps/web/src/components/settings/ChatGptAccountPicker.tsx": 4,
        "apps/web/src/components/pullRequest/PullRequestDetailLayout.tsx": 4,
        "apps/web/src/components/settings/ProjectActionsList.tsx": 1,
        "apps/web/src/components/settings/ProviderSettingsPanel.tsx": 2,
        "apps/web/src/components/settings/SettingsSidebarNav.tsx": 3,
        "apps/web/src/components/ThreadStatusIndicators.tsx": 4,
        "apps/web/src/components/ThreadTerminalDrawer.tsx": 1,
        "apps/web/src/components/usage/UsageLimits.tsx": 4,
        "apps/web/src/routes/__root.tsx": 4,
        "apps/web/src/components/pullRequest/PullRequestsPage.tsx": 2,
        "apps/web/src/components/pullRequest/PullRequestListGroups.tsx": 2,
        "apps/web/src/browser/BrowserDeviceToolbar.tsx": 3,
        "apps/web/src/components/BranchToolbarEnvModeSelector.tsx": 1,
        "apps/web/src/components/chat/ComposerCommandMenu.tsx": 2,
        "apps/web/src/components/chat/ComposerControl.tsx": 3,
        "apps/web/src/components/chat/ExpandedImageDialog.tsx": 3,
        "apps/web/src/components/chat/ModelListRow.tsx": 3,
        "apps/web/src/components/chat/ModelPickerContent.tsx": 3,
        "apps/web/src/components/chat/TerminalContextInlineChip.tsx": 3,
        "apps/web/src/components/chat/ThreadDetailsPrRow.tsx": 3,
        "apps/web/src/components/device/DeviceLoadingView.tsx": 3,
        "apps/web/src/components/device/DeviceStreamView.tsx": 3,
        "apps/web/src/components/files/FileBrowserPanel.tsx": 3,
        "apps/web/src/components/files/fileSurfaceChrome.tsx": 1,
        "apps/web/src/components/permissions/PermissionChecklist.tsx": 3,
        "apps/web/src/components/pullRequest/PullRequestLinkPreview.tsx": 3,
        "apps/web/src/components/pullRequest/PullRequestThreadLinks.tsx": 3,
        "apps/web/src/components/pullRequest/ThreadPullRequestsPanel.tsx": 1,
        "apps/web/src/components/ServerUpdateAction.tsx": 3,
        "apps/web/src/components/settings/FoldedSettingsSection.tsx": 3,
        "apps/web/src/components/settings/ProjectDefaultsSettings.tsx": 1,
        "apps/web/src/components/settings/ProviderSettingsForm.tsx": 3,
        "apps/web/src/components/SlowRpcRequestToastCoordinator.tsx": 1,
        "apps/web/src/components/usage/UsageProviderChart.tsx": 3,
        "apps/web/src/components/BranchToolbarBranchSelector.tsx": 2,
        "apps/web/src/components/chat/AssistantCitationCommentEditor.tsx": 2,
        "apps/web/src/components/chat/CompactComposerControlsMenu.tsx": 2,
        "apps/web/src/components/chat/ComposerBanner.tsx": 2,
        "apps/web/src/components/chat/ComposerBannerStack.tsx": 1,
        "apps/web/src/components/chat/DiffStatLabel.tsx": 2,
        "apps/web/src/components/chat/DraftHeroHeadline.tsx": 2,
        "apps/web/src/components/chat/ProposedPlanCard.tsx": 2,
        "apps/web/src/components/chat/ProviderInstanceIcon.tsx": 2,
        "apps/web/src/components/chat/ProviderSubagentBar.tsx": 2,
        "apps/web/src/components/chat/ThreadContextDragGhost.tsx": 1,
        "apps/web/src/components/chat/TimelineSystemDivider.tsx": 2,
        "apps/web/src/components/chat/useAutoBalanceUpdateBanner.tsx": 2,
        "apps/web/src/components/ComposerPromptEditorTiptap.tsx": 2,
        "apps/web/src/components/device/DeviceHostUpdates.tsx": 2,
        "apps/web/src/components/diffs/DiffFileTree.tsx": 2,
        "apps/web/src/components/files/DelimitedTablePreview.tsx": 2,
        "apps/web/src/components/files/ProjectFilePicker.tsx": 2,
        "apps/web/src/components/NoActiveThreadState.tsx": 2,
        "apps/web/src/components/preview/PreviewRecentUrlCard.tsx": 1,
        "apps/web/src/components/pullRequest/PullRequestActivityUnavailableState.tsx": 2,
        "apps/web/src/components/pullRequest/pullRequestPresentation.tsx": 2,
        "apps/web/src/components/pullRequest/PullRequestReactions.tsx": 2,
        "apps/web/src/components/PullRequestContextDetails.tsx": 2,
        "apps/web/src/components/settings/EnvironmentRow.tsx": 2,
        "apps/web/src/components/settings/ProjectActionsSettings.tsx": 1,
        "apps/web/src/components/settings/ProviderAccentColorPicker.tsx": 2,
        "apps/web/src/components/ThreadHoverCard.tsx": 2,
        "apps/web/src/components/ThreadSearchMatch.tsx": 2,
        "apps/web/src/components/WorkspaceBreadcrumb.tsx": 2,
        "apps/web/src/contextMenuFallback.ts": 1,
        "apps/web/src/browser/HostedBrowserWebview.tsx": 1,
        "apps/web/src/components/BranchToolbarEnvironmentSelector.tsx": 1,
        "apps/web/src/components/chat/ChatGptSharingControl.tsx": 1,
        "apps/web/src/components/chat/ComposerPrimaryActions.tsx": 1,
        "apps/web/src/components/chat/ProviderModelPicker.tsx": 1,
        "apps/web/src/components/chat/SubagentTooltipContent.tsx": 1,
        "apps/web/src/components/chat/WorkLog.tsx": 1,
        "apps/web/src/components/ContextChip.tsx": 1,
        "apps/web/src/components/device/DeviceAndroidFoldControls.tsx": 1,
        "apps/web/src/components/device/DeviceDuoControls.tsx": 1,
        "apps/web/src/components/device/DeviceHostAvailability.tsx": 1,
        "apps/web/src/components/device/DeviceWorkspace.tsx": 1,
        "apps/web/src/components/files/FileBreadcrumbs.tsx": 1,
        "apps/web/src/components/media/MediaVideoPlayer.tsx": 1,
        "apps/web/src/components/preview/PreviewMoreMenu.tsx": 1,
        "apps/web/src/components/preview/PreviewPanel.tsx": 1,
        "apps/web/src/components/preview/ThreadPreviewMiniPlayer.tsx": 1,
        "apps/web/src/components/preview/ZoomIndicator.tsx": 1,
        "apps/web/src/components/PreviousWorktreeItemContent.tsx": 1,
        "apps/web/src/components/pullRequest/PullRequestMarkdown.tsx": 1,
        "apps/web/src/components/pullRequest/PullRequestMarkdownEditor.tsx": 1,
        "apps/web/src/components/pullRequest/PullRequestRow.tsx": 1,
        "apps/web/src/components/QuitHoldOverlay.tsx": 1,
        "apps/web/src/components/settings/EnvironmentIconPicker.tsx": 1,
        "apps/web/src/components/settings/FontFamilyPicker.tsx": 1,
        "apps/web/src/components/settings/LocalEnvironmentSetting.tsx": 1,
        "apps/web/src/components/settings/ProviderSetupSection.tsx": 1,
        "apps/web/src/components/settings/RedactedSensitiveText.tsx": 1,
        "apps/web/src/components/sidebar/SidebarProviderUpdatePill.tsx": 1,
        "apps/web/src/components/ThreadCommandSubtitle.tsx": 1,
      }).map(([file, maxOccurrences]) => {
        const rule: ["error", { maxOccurrences: number }] = ["error", { maxOccurrences }];
        return { files: [file], rules: { "t3code/no-raw-type-classes": rule } };
      }),
    ],
    options: {
      reportUnusedDisableDirectives: "error",
      typeAware: false,
      typeCheck: false,
    },
  },
});
