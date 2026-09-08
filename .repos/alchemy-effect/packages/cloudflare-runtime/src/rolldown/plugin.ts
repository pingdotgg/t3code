import type * as rolldown from "rolldown";
import { esmExternalRequirePlugin } from "rolldown/plugins";
import type { BasePluginOptions } from "./options.ts";
import {
  additionalModulesPlugin,
  cloudflareExternalsPlugin,
  getUnenv,
  nodejsAlsPlugin,
  nodejsImportWarningPlugin,
  nodejsUnenvPlugin,
  optionsPlugin,
  virtualModulesPlugin,
  wasmInitPlugin,
} from "./plugins/index.ts";
import { hasNodejsCompat } from "./utils.ts";

export type RolldownPluginOptions = Omit<BasePluginOptions, "viteEnvironment">;

export type RolldownPlugin = (
  options?: RolldownPluginOptions,
) => Array<rolldown.Plugin | null>;

const cloudflare: RolldownPlugin = (options = {}) => {
  return [
    hasNodejsCompat(options.compatibilityFlags)
      ? esmExternalRequirePlugin({
          external: [...getUnenv(options).external],
          skipDuplicateCheck: true,
        })
      : null,
    optionsPlugin.rolldown(options),
    cloudflareExternalsPlugin.rolldown(options),
    nodejsAlsPlugin.rolldown(options),
    nodejsImportWarningPlugin.rolldown(options),
    nodejsUnenvPlugin.rolldown(options),
    virtualModulesPlugin.rolldown(options),
    wasmInitPlugin.rolldown(options),
    additionalModulesPlugin.rolldown(options),
  ];
};

export default cloudflare;
