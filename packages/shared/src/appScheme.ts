declare const __T3CODE_BUILD_APP_SCHEME__: string | undefined;

/**
 * The deep-link scheme this build registers and writes into links; development builds append
 * `-dev`. A fork bakes in its own with `T3CODE_APP_SCHEME` so it never opens in T3 Code's place.
 */
export const APP_SCHEME: string =
  typeof __T3CODE_BUILD_APP_SCHEME__ === "string" ? __T3CODE_BUILD_APP_SCHEME__ : "t3code";

/**
 * Any non-web scheme reads as an app link: the OS hands each app only the schemes it registered,
 * and a link pasted or scanned from another T3 Code build, such as `t3code://pair`, means the same.
 */
export const isAppLinkProtocol = (protocol: string): boolean =>
  /^[a-z][a-z0-9.+-]*:$/i.test(protocol) && !/^(?:https?|wss?|file):$/i.test(protocol);
