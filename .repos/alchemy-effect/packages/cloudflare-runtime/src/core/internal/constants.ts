export const SOCKET_USER_ENTRY = "user-entry";
export const SERVICE_USER_WORKER = "user-worker";

export const defaultDurableObjectUniqueKey = (
  scriptName: string,
  className: string,
) => `${encodeURIComponent(scriptName)}-${encodeURIComponent(className)}`;
