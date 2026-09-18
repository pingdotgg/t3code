export const SOCKET_USER_ENTRY = "user-entry";
export const SERVICE_USER_WORKER = "user-worker";

/**
 * Default date shared by deployed Workers, framework runners, previews, and
 * internal isolates. It is the newest date supported by catalog workerd.
 */
export const DEFAULT_COMPATIBILITY_DATE = "2026-08-31";

export const defaultDurableObjectUniqueKey = (
  scriptName: string,
  className: string,
) => `${encodeURIComponent(scriptName)}-${encodeURIComponent(className)}`;
