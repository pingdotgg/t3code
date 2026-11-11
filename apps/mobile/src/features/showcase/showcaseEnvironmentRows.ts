import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";

const SHOWCASE_LOCAL_ENVIRONMENT_DISPLAY_URLS: Readonly<Record<string, string>> = {
  "Moonbase Terminal": "https://moonbase.tail9f3a.ts.net/",
  "Suspense Station": "https://suspense-vps.hel1.t3.sh/",
  "Kernel Cabin": "http://100.82.16.5:3773/",
};

export function applyShowcaseLocalEnvironmentDisplayUrls(
  environments: ReadonlyArray<ConnectedEnvironmentSummary>,
): ReadonlyArray<ConnectedEnvironmentSummary> {
  return environments.map((environment) => ({
    ...environment,
    displayUrl:
      SHOWCASE_LOCAL_ENVIRONMENT_DISPLAY_URLS[environment.environmentLabel] ??
      environment.displayUrl,
  }));
}

export function resolveShowcaseEnvironmentUpdateDisplayUrl(input: {
  readonly actualDisplayUrl: string;
  readonly presentedDisplayUrl: string;
  readonly submittedDisplayUrl: string;
}): string {
  return input.submittedDisplayUrl === input.presentedDisplayUrl
    ? input.actualDisplayUrl
    : input.submittedDisplayUrl;
}
