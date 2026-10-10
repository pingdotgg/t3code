import { definePlugin } from "@oxlint/plugins";

import namespaceNodeImports from "./rules/namespace-node-imports.ts";
import noGlobalProcessRuntime from "./rules/no-global-process-runtime.ts";
import noHermesUnsupportedApis from "./rules/no-hermes-unsupported-apis.ts";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import noManualEffectRuntimeInTests from "./rules/no-manual-effect-runtime-in-tests.ts";
import noMobileUniwindThemeEscapeHatches from "./rules/no-mobile-uniwind-theme-escape-hatches.ts";
import noNativeTitleTooltip from "./rules/no-native-title-tooltip.ts";
import noOutsetStateIndicators from "./rules/no-outset-state-indicators.ts";
import noRawMcpRegistration from "./rules/no-raw-mcp-registration.ts";
import noRawResizeObserver from "./rules/no-raw-resize-observer.ts";
import noTestInLoop from "./rules/no-test-in-loop.ts";
import noRpcPermissionBypass from "./rules/no-rpc-permission-bypass.ts";
import noUnscopedHas from "./rules/no-unscoped-has.ts";
import preferCatchTags from "./rules/prefer-catch-tags.ts";
import requireCenteredScrollGutter from "./rules/require-centered-scroll-gutter.ts";
import requireSuppressionReason from "./rules/require-suppression-reason.ts";

export default definePlugin({
  meta: {
    name: "t3code",
  },
  rules: {
    "namespace-node-imports": namespaceNodeImports,
    "no-global-process-runtime": noGlobalProcessRuntime,
    "no-hermes-unsupported-apis": noHermesUnsupportedApis,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests,
    "no-mobile-uniwind-theme-escape-hatches": noMobileUniwindThemeEscapeHatches,
    "no-native-title-tooltip": noNativeTitleTooltip,
    "no-outset-state-indicators": noOutsetStateIndicators,
    "no-raw-mcp-registration": noRawMcpRegistration,
    "no-raw-resize-observer": noRawResizeObserver,
    "no-test-in-loop": noTestInLoop,
    "no-rpc-permission-bypass": noRpcPermissionBypass,
    "no-unscoped-has": noUnscopedHas,
    "prefer-catch-tags": preferCatchTags,
    "require-centered-scroll-gutter": requireCenteredScrollGutter,
    "require-suppression-reason": requireSuppressionReason,
  },
});
