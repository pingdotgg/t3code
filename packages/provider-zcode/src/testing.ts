/**
 * ZCode internals the server's replay testkit and fixture recorder drive
 * directly.
 *
 * @module provider-zcode/testing
 */
export {
  ZCODE_DEFAULT_INSTANCE_ID,
  ZCODE_PROVIDER,
  makeZCodeAdapterV2,
  type ZCodeAdapterV2Options,
} from "./server/adapter.ts";
export { makeZCodeAcpRuntime } from "./server/acpSupport.ts";
