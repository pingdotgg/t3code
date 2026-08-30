import { AppState } from "react-native";
import { WORKSPACE_EXTERNAL_OPEN_MAX_BYTES } from "@t3tools/shared/filePreview";

import { beginForegroundHandoff } from "../../lib/foreground-handoff";
import {
  buildExternalViewIntent,
  isNoHandlerLaunchError,
  sanitizeHandoffFileName,
  type ExternalOpenLaunch,
} from "./workspace-file-external-open";

const HANDOFF_DIRECTORY_NAME = "external-open-handoff";

// expo-file-system binds its native module at import, so load it lazily like
// the rest of the app (see incoming-share-storage.ts) to keep it off cold
// start — this feature only ever runs on Android on an external-open file.
async function handoffRoot() {
  const { Directory, Paths } = await import("expo-file-system");
  return new Directory(Paths.cache, HANDOFF_DIRECTORY_NAME);
}

/** Deletes every past handoff file. An external viewer holding the previous
    file open keeps reading through its fd; only a re-open after this point
    misses, which the at-most-one-file policy accepts. */
async function deleteHandoffRoot(): Promise<void> {
  try {
    const root = await handoffRoot();
    if (root.exists) {
      root.delete();
    }
  } catch {
    // Best effort; the next prune retries.
  }
}

let stalePrune: Promise<void> | null = null;

/** Clears handoff files left behind by a previous app session. Runs once per
    JS runtime; `downloadHandoffFile` awaits it so a deferred prune can never
    delete the handoff file it is about to create. */
export function pruneStaleHandoffFiles(): void {
  stalePrune ??= deleteHandoffRoot();
}

/** Downloads the signed asset URL into the ephemeral handoff area and resolves
    with the local content URI. Keeps at most one completed handoff file,
    aborts past the size cap, and removes partial files before rejecting. */
export async function downloadHandoffFile(
  url: string,
  fileName: string,
  signal: AbortSignal,
): Promise<{ contentUri: string }> {
  stalePrune ??= Promise.resolve();
  await stalePrune;
  await deleteHandoffRoot();
  const { Directory, File } = await import("expo-file-system");
  const { uuidv4 } = await import("../../lib/uuid");
  // A unique subdirectory per handoff keeps the original basename (which the
  // receiving app displays) collision-safe even when a prune fails.
  const directory = new Directory(await handoffRoot(), uuidv4());
  directory.create({ intermediates: true, idempotent: true });
  const destination = new File(directory, sanitizeHandoffFileName(fileName));
  // The mint-time cap re-checked here so a file that grew after signing (or a
  // response that ignores it) cannot fill the device cache.
  const capAbort = new AbortController();
  const onCallerAbort = () => capAbort.abort();
  signal.addEventListener("abort", onCallerAbort, { once: true });
  let tooLarge = false;
  try {
    const downloaded = await File.downloadFileAsync(url, destination, {
      signal: capAbort.signal,
      onProgress: ({ bytesWritten }) => {
        if (bytesWritten > WORKSPACE_EXTERNAL_OPEN_MAX_BYTES && !tooLarge) {
          tooLarge = true;
          capAbort.abort();
        }
      },
    });
    return { contentUri: downloaded.contentUri };
  } catch (error) {
    try {
      directory.delete();
    } catch {
      // The partial file goes with the next prune instead.
    }
    if (tooLarge) {
      throw new Error("The file is too large to open in another app.", { cause: error });
    }
    if (signal.aborted) {
      throw error;
    }
    throw new Error("The file could not be downloaded.", { cause: error });
  } finally {
    signal.removeEventListener("abort", onCallerAbort);
  }
}

/** Hands the local content URI to whichever installed Android app handles the
    MIME type. Settles only when the external activity returns; the viewer
    session registers as a foreground handoff so background-triggered restarts
    stay away mid-view, with the app's return to the foreground as the release
    fallback when the activity result is lost. */
export async function launchExternalViewer(launch: ExternalOpenLaunch): Promise<unknown> {
  const IntentLauncher = await import("expo-intent-launcher");
  const intent = buildExternalViewIntent(launch);
  const endHandoff = beginForegroundHandoff();
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") {
      endHandoff();
    }
  });
  try {
    return await IntentLauncher.startActivityAsync(intent.action, intent.params);
  } catch (error) {
    // The no-handler rejection keeps its platform message so the controller
    // can recognize it; everything else becomes product copy.
    throw isNoHandlerLaunchError(error)
      ? error
      : new Error("The file could not be opened in another app.", { cause: error });
  } finally {
    subscription.remove();
    endHandoff();
  }
}
