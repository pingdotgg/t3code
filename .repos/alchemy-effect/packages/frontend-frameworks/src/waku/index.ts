import { layer, type WakuFrameworkOptions } from "./Waku.ts";

export {
  DEFAULT_TARGET_SPECIFIER,
  layer,
  make,
  makeWakuConfigInput,
  makeWakuServerEntryPlugin,
  mergeUserWakuConfig,
  selectWakuTargetInput,
  WAKU_CONFIG_FILES,
  WAKU_SERVER_ENTRY_ID,
  WAKU_SERVER_ENTRY_MODULE,
  WAKU_SERVER_ENTRY_PATH,
  type MergeUserWakuConfigInputs,
  type WakuConfigInputs,
  type WakuFrameworkOptions,
  type WakuHarnessTargetOptions,
  type WakuTarget,
  type WakuTargetContext,
  type WakuTargetInputSelection,
  type WakuTargetOption,
} from "./Waku.ts";

/**
 * The e2e-harness framework factory contract: default-export a
 * `(options) => Layer<Framework>` factory. The harness's target-scoped
 * carriage (`options.target.cloudflare.worker`, with the deprecated
 * top-level `vite` as alias) is read structurally by `make`.
 */
const framework = (options?: WakuFrameworkOptions) => layer(options);

export default framework;
