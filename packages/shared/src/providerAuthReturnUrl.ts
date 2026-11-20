import { APP_SCHEME } from "./appScheme.ts";
import { BUILD_HOSTED_APP_URL } from "./connectAuth.ts";
import { isLoopbackHost } from "./preview.ts";

export function providerAuthReturnUrl(
  value: string | undefined,
  hostedAppUrl: string = BUILD_HOSTED_APP_URL,
  appScheme: string = APP_SCHEME,
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const desktop =
      [`${appScheme}:`, `${appScheme}-dev:`].includes(url.protocol) && url.host === "app";
    const web =
      ["http:", "https:"].includes(url.protocol) &&
      (isLoopbackHost(url.hostname) || url.origin === hostedAppUrl);
    if (
      url.username ||
      url.password ||
      (!desktop && !web) ||
      (url.pathname !== "/welcome" &&
        url.pathname !== "/settings" &&
        !url.pathname.startsWith("/settings/"))
    )
      return undefined;
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        url.pathname === "/welcome" ||
        !["machine", "project", "checkout", "environmentId", "instanceId"].includes(key)
      ) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname !== "/welcome" || !/^#agents:[\w-]+$/u.test(url.hash)) url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

/** A redirect to a provider web page, not a loopback listener, lands on a page showing a code to paste. */
export function providerAuthRedirectShowsCode(authorizationUrl: string): boolean {
  try {
    const redirect = new URL(new URL(authorizationUrl).searchParams.get("redirect_uri") ?? "");
    return redirect.protocol === "https:" && !isLoopbackHost(redirect.hostname);
  } catch {
    return false;
  }
}
