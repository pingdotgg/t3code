import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as JsxDevRuntime from "react/jsx-dev-runtime";
import {
  installPluginRuntime,
  pluginEffectModules,
  PLUGIN_WEB_RUNTIME_KEY,
} from "@t3tools/shared/pluginRuntime";

/** Browser source imports resolve to the same singleton modules used by native UI. */
export function installWebPluginModules() {
  installPluginRuntime(PLUGIN_WEB_RUNTIME_KEY, {
    ...pluginEffectModules,
    react: { ...React, default: React },
    "react/jsx-runtime": JsxRuntime,
    "react/jsx-dev-runtime": JsxDevRuntime,
  });
}
