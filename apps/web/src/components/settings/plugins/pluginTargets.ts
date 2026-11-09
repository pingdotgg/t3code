import type { EnvironmentPresentation } from "../../../state/environments";

export const runsPlugins = (environment: EnvironmentPresentation) =>
  environment.connection.phase === "connected" &&
  environment.serverConfig?.environment.capabilities.plugins === true;
