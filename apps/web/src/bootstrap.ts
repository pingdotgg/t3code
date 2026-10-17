import { showBootError } from "./lib/bootError";
import { restoreStackTraces, suspendStackTracesForAppImport } from "./lib/bootStackTraces";

// Bundled dev can move UI code into shared chunks. Load it only after this
// entry runs the React refresh preamble, and catch failures before React mounts.
suspendStackTracesForAppImport();
void import("./main")
  .then(({ startup }) => startup)
  .catch((error: unknown) => {
    const duringAppImport = restoreStackTraces();
    showBootError(error);
    if (duringAppImport) {
      console.error(
        "Stack traces were off while the app's modules loaded (Error.stackTraceLimit = 0), so this error has no stack frames.",
      );
    }
  });
