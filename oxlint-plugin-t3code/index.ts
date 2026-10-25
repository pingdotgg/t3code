import { definePlugin } from "@oxlint/plugins";

import namespaceNodeImports from "./rules/namespace-node-imports.ts";
import noDomTestEnvironment from "./rules/no-dom-test-environment.ts";
import noEmDashCopy from "./rules/no-em-dash-copy.ts";
import noFrameWaitsInBrowserTests from "./rules/no-frame-waits-in-browser-tests.ts";
import noGlobalProcessRuntime from "./rules/no-global-process-runtime.ts";
import noHermesUnsupportedApis from "./rules/no-hermes-unsupported-apis.ts";
import noHooklessUseFunction from "./rules/no-hookless-use-function.ts";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import noLowValueComments from "./rules/no-low-value-comments.ts";
import noManualMemo from "./rules/no-manual-memo.ts";
import noManualEffectRuntimeInTests from "./rules/no-manual-effect-runtime-in-tests.ts";
import noMobileUniwindThemeEscapeHatches from "./rules/no-mobile-uniwind-theme-escape-hatches.ts";
import noAmbiguousDetailNavigation from "./rules/no-ambiguous-detail-navigation.ts";
import noMobilePullRequestGlyphLiterals from "./rules/no-mobile-pull-request-glyph-literals.ts";
import noNativeTitleTooltip from "./rules/no-native-title-tooltip.ts";
import requireRegisteredListScroll from "./rules/require-registered-list-scroll.ts";
import noOutsetStateIndicators from "./rules/no-outset-state-indicators.ts";
import noPollingLoopInTests from "./rules/no-polling-loop-in-tests.ts";
import noRawMcpRegistration from "./rules/no-raw-mcp-registration.ts";
import noRawResizeObserver from "./rules/no-raw-resize-observer.ts";
import noRealTimeWaitInTests from "./rules/no-real-time-wait-in-tests.ts";
import noTestInLoop from "./rules/no-test-in-loop.ts";
import noTestTimeoutOrUnreasonedSkip from "./rules/no-test-timeout-or-unreasoned-skip.ts";
import noRpcPermissionBypass from "./rules/no-rpc-permission-bypass.ts";
import noUnscopedHas from "./rules/no-unscoped-has.ts";
import noWallClockInTests from "./rules/no-wall-clock-in-tests.ts";
import preferCatchTags from "./rules/prefer-catch-tags.ts";
import preferEffectFn from "./rules/prefer-effect-fn.ts";
import requireCenteredScrollGutter from "./rules/require-centered-scroll-gutter.ts";
import requireDisposableRender from "./rules/require-disposable-render.ts";
import requireSuppressionReason from "./rules/require-suppression-reason.ts";

export default definePlugin({
  meta: {
    name: "t3code",
  },
  rules: {
    "namespace-node-imports": namespaceNodeImports,
    "no-dom-test-environment": noDomTestEnvironment,
    "no-em-dash-copy": noEmDashCopy,
    "no-frame-waits-in-browser-tests": noFrameWaitsInBrowserTests,
    "no-global-process-runtime": noGlobalProcessRuntime,
    "no-hermes-unsupported-apis": noHermesUnsupportedApis,
    "no-hookless-use-function": noHooklessUseFunction,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-low-value-comments": noLowValueComments,
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests,
    "no-manual-memo": noManualMemo,
    "no-mobile-uniwind-theme-escape-hatches": noMobileUniwindThemeEscapeHatches,
    "no-ambiguous-detail-navigation": noAmbiguousDetailNavigation,
    "no-mobile-pull-request-glyph-literals": noMobilePullRequestGlyphLiterals,
    "no-native-title-tooltip": noNativeTitleTooltip,
    "require-registered-list-scroll": requireRegisteredListScroll,
    "no-outset-state-indicators": noOutsetStateIndicators,
    "no-polling-loop-in-tests": noPollingLoopInTests,
    "no-raw-mcp-registration": noRawMcpRegistration,
    "no-raw-resize-observer": noRawResizeObserver,
    "no-real-time-wait-in-tests": noRealTimeWaitInTests,
    "no-test-in-loop": noTestInLoop,
    "no-test-timeout-or-unreasoned-skip": noTestTimeoutOrUnreasonedSkip,
    "no-rpc-permission-bypass": noRpcPermissionBypass,
    "no-unscoped-has": noUnscopedHas,
    "no-wall-clock-in-tests": noWallClockInTests,
    "prefer-catch-tags": preferCatchTags,
    "prefer-effect-fn": preferEffectFn,
    "require-centered-scroll-gutter": requireCenteredScrollGutter,
    "require-disposable-render": requireDisposableRender,
    "require-suppression-reason": requireSuppressionReason,
  },
});
