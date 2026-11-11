export {
  ZCODE_PROVIDER,
  makeZcodeAdapterV2,
  type ZcodeAdapterV2Options,
} from "./server/adapter.ts";
// Wire-shape types for frame-driven testkits; knip tracks types separately from consumed exports.
export type {
  ZcodeConnection,
  ZcodeProtocolError,
  ZcodeProtocolTimeoutError,
  ZcodeRecord,
} from "./server/zcodeProtocol.ts";
