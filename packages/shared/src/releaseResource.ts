import { type CliReleaseChannel, cliReleaseChannelOf } from "./cliRelease.ts";

export type ReleaseChannel = "dev" | CliReleaseChannel;

/**
 * The release identity of the build that produced a signal. `preview` builds
 * are internal and have no update feed, so they report `staging`. An operator
 * value in `OTEL_RESOURCE_ATTRIBUTES` wins for either key, and `channel`
 * replaces the one the version implies for builds that cannot carry it there.
 */
export const releaseResourceAttributes = (input: {
  readonly version: string;
  readonly isDevelopment: boolean;
  readonly operatorAttributes: Readonly<Record<string, unknown>>;
  readonly channel?: CliReleaseChannel | undefined;
}): {
  readonly "t3code.release.channel": string;
  readonly "deployment.environment.name": string;
} => {
  const releaseChannel: ReleaseChannel = input.isDevelopment
    ? "dev"
    : (input.channel ?? cliReleaseChannelOf(input.version));
  const environment =
    releaseChannel === "dev"
      ? "development"
      : releaseChannel === "preview"
        ? "staging"
        : "production";
  const operatorValue = (key: string) => {
    const value = input.operatorAttributes[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  return {
    "t3code.release.channel": operatorValue("t3code.release.channel") ?? releaseChannel,
    "deployment.environment.name": operatorValue("deployment.environment.name") ?? environment,
  };
};
