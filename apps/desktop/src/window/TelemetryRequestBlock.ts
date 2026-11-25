import { BLOCKED_TELEMETRY_URL_PATTERNS } from "@t3tools/shared/telemetryBlocklist";

/** Cancels every request from this session to upstream's analytics and trace hosts. */
export function installTelemetryRequestBlock(
  session: Pick<Electron.Session, "webRequest">,
): () => void {
  session.webRequest.onBeforeRequest({ urls: [...BLOCKED_TELEMETRY_URL_PATTERNS] }, (_, callback) =>
    callback({ cancel: true }),
  );
  return () => {
    session.webRequest.onBeforeRequest(null);
  };
}
