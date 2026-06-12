export function clerkFrontendApiUrlFromPublishableKey(publishableKey: string): string {
  const encodedFrontendApi = publishableKey.split("_").slice(2).join("_");
  const frontendApi = globalThis.atob(encodedFrontendApi).replace(/\$$/u, "");
  if (frontendApi.length === 0 || frontendApi.includes("/")) {
    throw new Error("Invalid Clerk publishable key.");
  }
  return `https://${frontendApi}`;
}

export function clerkFrontendApiHostnameFromPublishableKey(publishableKey: string): string {
  return new URL(clerkFrontendApiUrlFromPublishableKey(publishableKey)).hostname;
}

export function isAllowedClerkFrontendApiHostname(
  hostname: string,
  configuredHostname: string | null,
): boolean {
  return (
    hostname.endsWith(".clerk.accounts.dev") ||
    hostname.endsWith(".clerk.accounts.com") ||
    hostname === configuredHostname
  );
}

export function relayClerkTokenOptions(template: string) {
  return {
    template,
    skipCache: true,
  } as const;
}
