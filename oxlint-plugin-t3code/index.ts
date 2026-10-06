import { definePlugin } from "@oxlint/plugins";

import namespaceNodeImports from "./rules/namespace-node-imports.ts";
import noGlobalProcessRuntime from "./rules/no-global-process-runtime.ts";
import noHermesUnsupportedApis from "./rules/no-hermes-unsupported-apis.ts";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import noManualEffectRuntimeInTests from "./rules/no-manual-effect-runtime-in-tests.ts";
import noMobileUniwindThemeEscapeHatches from "./rules/no-mobile-uniwind-theme-escape-hatches.ts";
import noNativeTitleTooltip from "./rules/no-native-title-tooltip.ts";
import noTestInLoop from "./rules/no-test-in-loop.ts";
import noUnscopedHas from "./rules/no-unscoped-has.ts";
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
    "no-test-in-loop": noTestInLoop,
    "no-unscoped-has": noUnscopedHas,
    "require-suppression-reason": requireSuppressionReason,
  },
});
