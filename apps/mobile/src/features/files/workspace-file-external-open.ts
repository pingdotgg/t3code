/** Drives the "Open in another app" handoff for workspace files T3 cannot
    preview. Pure orchestration: the expo-file-system download and Android
    intent launch are injected so the flow stays unit-testable. */
import { basename } from "./filePath";

export const EXTERNAL_OPEN_VIEW_ACTION = "android.intent.action.VIEW";

/** Android `Intent.FLAG_GRANT_READ_URI_PERMISSION`: the receiving activity may
    read the content URI for as long as it runs. */
export const FLAG_GRANT_READ_URI_PERMISSION = 1;

export type ExternalOpenStatus =
  | { readonly _tag: "idle" }
  | { readonly _tag: "preparing" }
  | { readonly _tag: "no-handler" }
  | { readonly _tag: "error"; readonly detail: string | null };

export interface ExternalOpenLaunch {
  readonly contentUri: string;
  readonly mimeType: string;
}

/** The `startActivityAsync` arguments for viewing a local content URI in
    whichever installed app handles the MIME type. */
export function buildExternalViewIntent(launch: ExternalOpenLaunch) {
  return {
    action: EXTERNAL_OPEN_VIEW_ACTION,
    params: {
      data: launch.contentUri,
      type: launch.mimeType,
      flags: FLAG_GRANT_READ_URI_PERMISSION,
    },
  };
}

/** Reduces a remote basename to a safe local filename while keeping the
    extension the receiving app dispatches on and the letters the receiving
    app displays. */
export function sanitizeHandoffFileName(fileName: string): string {
  const cleaned = basename(fileName)
    .replace(/[^\p{L}\p{N}.\-_ ()]+/gu, "_")
    .replace(/^\.+/, "")
    .slice(-100)
    .replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned : "file";
}

/** Android rejects the launch with the platform ActivityNotFoundException when
    nothing handles the intent; expo surfaces it as a plain rejection. */
export function isNoHandlerLaunchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no activity found/i.test(message);
}

function errorDetail(error: unknown): string | null {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : null;
}

export function createExternalOpenController(deps: {
  readonly fileName: string;
  readonly mimeType: string;
  /** Downloads the signed URL into the local handoff file and resolves with
      its content URI. Must clean up partial files before rejecting and honor
      the abort signal. */
  readonly downloadHandoffFile: (
    url: string,
    fileName: string,
    signal: AbortSignal,
  ) => Promise<{ contentUri: string }>;
  readonly launchViewer: (launch: ExternalOpenLaunch) => Promise<unknown>;
  readonly onStatusChange: (status: ExternalOpenStatus) => void;
}) {
  let busy = false;
  let disposed = false;
  // The native launcher is single-flight until the external activity returns;
  // extra presses while the viewer is up are no-ops, not errors.
  let launchInFlight = false;
  let activeAbort: AbortController | null = null;

  const setStatus = (status: ExternalOpenStatus) => {
    if (!disposed) {
      deps.onStatusChange(status);
    }
  };

  return {
    isDisposed: () => disposed,
    /** Aborts any in-flight download and suppresses a not-yet-initiated
        launch; the screen is gone, so no viewer may open on its behalf. */
    dispose: () => {
      disposed = true;
      activeAbort?.abort();
    },
    /** `requestAssetUrl` must mint a fresh signed URL on every call so a
        failed or expired grant is never reused. */
    open: async (requestAssetUrl: () => Promise<string>): Promise<void> => {
      if (busy || launchInFlight || disposed) {
        return;
      }
      busy = true;
      const abort = new AbortController();
      activeAbort = abort;
      setStatus({ _tag: "preparing" });

      let handoff: { readonly contentUri: string };
      try {
        handoff = await deps.downloadHandoffFile(
          await requestAssetUrl(),
          deps.fileName,
          abort.signal,
        );
      } catch (error) {
        if (!abort.signal.aborted) {
          setStatus({ _tag: "error", detail: errorDetail(error) });
        }
        return;
      } finally {
        busy = false;
        activeAbort = null;
      }
      if (disposed) {
        return;
      }

      // startActivityAsync only settles once the external activity returns, so
      // the viewer's lifetime must not read as an in-progress T3 operation:
      // clear "preparing" as soon as the launch is initiated and surface a
      // rejection (such as no installed handler) out of band.
      launchInFlight = true;
      const launch = deps.launchViewer({
        contentUri: handoff.contentUri,
        mimeType: deps.mimeType,
      });
      setStatus({ _tag: "idle" });
      launch.then(
        () => {
          launchInFlight = false;
        },
        (error) => {
          launchInFlight = false;
          setStatus(
            isNoHandlerLaunchError(error)
              ? { _tag: "no-handler" }
              : { _tag: "error", detail: errorDetail(error) },
          );
        },
      );
    },
  };
}
