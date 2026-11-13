import { showBootError } from "./lib/bootError";
import { isChunkLoadError, reloadOnceForChunkLoadError } from "./lib/chunkReloadGuard";

// Shared dev chunks need the React refresh preamble first. Catch failures before React mounts.
void import("./main")
  .then(({ startup }) => startup)
  .catch((error: unknown) => {
    // main's own reload guard never runs when one of its static chunks fails to load.
    if (isChunkLoadError(error) && reloadOnceForChunkLoadError()) return;
    showBootError(error);
  });
