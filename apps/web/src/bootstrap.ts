import { showBootError } from "./lib/bootError";

let phase = "loading the app and waiting for the local backend";
let errorShown = false;
const fail = (error: unknown) => {
  if (errorShown) return;
  errorShown = true;
  showBootError(error);
};
// A pending import, IPC, or initial route request never reaches the rejection handler.
const deadline = setTimeout(
  () => fail(new Error(`Startup timed out while ${phase}. Reload to try again.`)),
  60_000,
);

// Shared dev chunks need the React refresh preamble first. Catch failures before React mounts.
void (async () => {
  const bridge = window.desktopBridge;
  // Load the app in parallel, keeping its services behind desktop's authenticated backend.
  const [{ startup }] = await Promise.all([
    import("./main"),
    bridge?.getLocalEnvironmentEnabled() ? bridge.getLocalEnvironmentBearerToken() : undefined,
  ]);
  phase = "loading the initial view";
  await startup();
})()
  .finally(() => clearTimeout(deadline))
  .catch(fail);
