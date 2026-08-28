import { definePlugin } from "@oxlint/plugins";

import namespaceNodeImports from "./rules/namespace-node-imports.ts";
import noGlobalProcessRuntime from "./rules/no-global-process-runtime.ts";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import noManualEffectRuntimeInTests from "./rules/no-manual-effect-runtime-in-tests.ts";
import noMobileUniwindThemeEscapeHatches from "./rules/no-mobile-uniwind-theme-escape-hatches.ts";
import noNativeTitleTooltip from "./rules/no-native-title-tooltip.ts";

export default definePlugin({
  meta: {
    name: "t3code",
  },
  rules: {
    "namespace-node-imports": namespaceNodeImports,
    "no-global-process-runtime": noGlobalProcessRuntime,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests,
    "no-mobile-uniwind-theme-escape-hatches": noMobileUniwindThemeEscapeHatches,
    "no-native-title-tooltip": noNativeTitleTooltip,
  },
});
