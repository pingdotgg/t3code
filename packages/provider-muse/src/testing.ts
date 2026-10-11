/**
 * Muse Code internals for replay tests and the fixture recorder: how Muse is
 * started, the MSP launch arguments, initialize parameters, environment, the
 * workspace root `turn/start` sends, and version parser.
 *
 * @module provider-muse/testing
 */
export {
  makeMuseEnvironment,
  museInitializeParams,
  museLaunch,
  museServeArgs,
  museWorkspaceRoot,
  type MuseSdkHost,
  type MuseSdkHostOptions,
} from "./server/sdk.ts";
export { parseMuseVersion } from "./server/maintenance.ts";
