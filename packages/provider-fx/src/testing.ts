/**
 * fx internals the server's replay tests and fixture recorder drive directly.
 *
 * @module provider-fx/testing
 */
export { FX_DRIVER_KIND, makeFxAdapterV2 } from "./server/adapter.ts";
export {
  FX_ACP_CANCEL_BEHAVIOR,
  FX_SUPPORTED_RUNTIME_MODES,
  makeFxAcpRuntime,
} from "./server/acpSupport.ts";
