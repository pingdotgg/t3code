import {
  cloudflareAccessAppLoginUrl,
  readCloudflareAccessAppCallback,
} from "@t3tools/shared/cloudflareAccessLogin";
import Constants from "expo-constants";
import * as WebBrowser from "expo-web-browser";

/** The server redirects to its build's base scheme; dev and preview app variants add a suffix. */
function serverAppScheme(registered: string | ReadonlyArray<string> | undefined): string {
  const scheme = (typeof registered === "string" ? registered : registered?.[0]) ?? "t3code";
  return scheme.replace(/-(?:dev|preview)$/, "");
}

/**
 * Signs in at `origin` through Cloudflare Access in the system auth session and returns the
 * one-time pairing credential, or null when the user cancels. iOS hands the callback straight
 * back to this session rather than to whichever app registered the scheme.
 */
export async function signInWithCloudflareAccess(origin: string): Promise<string | null> {
  const callbackUrl = `${serverAppScheme(Constants.expoConfig?.scheme)}://cloudflare-access`;
  const result = await WebBrowser.openAuthSessionAsync(
    cloudflareAccessAppLoginUrl(origin),
    callbackUrl,
  );
  if (result.type !== "success") return null;
  return readCloudflareAccessAppCallback(result.url);
}
