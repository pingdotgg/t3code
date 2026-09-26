import { showBootError } from "./lib/bootError";

// Bundled dev can move UI code into shared chunks. Load it only after this
// entry runs the React refresh preamble, and catch failures before React mounts.
// Primary auth and URL resolution read the desktop snapshot synchronously, so
// initialize it asynchronously before importing modules that use those reads.
void Promise.resolve()
  .then(() => window.desktopBridge?.refreshLocalEnvironment?.())
  .then(() => import("./main"))
  .then(({ startup }) => startup)
  .catch(showBootError);
