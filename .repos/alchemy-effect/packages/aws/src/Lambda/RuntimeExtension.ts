/**
 * Self-registered *internal extension* for the generated Lambda entry.
 *
 * Registering an internal extension buys the Shutdown phase: a sandbox
 * with no registered extensions is killed with no signal at all (0 ms);
 * with an internal extension Lambda sends SIGTERM and allows 500 ms before
 * SIGKILL — the entry closes the instance scope in that window.
 *
 * The extension deliberately subscribes to NO events (`events: []`).
 * Subscribing to `INVOKE` and holding `/event/next` open as a
 * post-response work window was tried and rejected: a buffered Function
 * URL does not return the response to the caller until the entire Invoke
 * phase completes, so held work showed up as response latency anyway — and
 * environments whose invoke phase was extended this way were observed
 * being condemned and recycled (no END/REPORT, SIGTERM within seconds,
 * fresh INIT on the next request). Per-invocation cleanup therefore
 * settles inline in the dispatch; keep request finalizers fast.
 *
 * A registered extension must signal readiness via the blocking
 * `/event/next` long-poll or the Init phase hangs; for an extension
 * subscribed to no events that call never resolves, so it is fired
 * un-awaited and parks for the sandbox's lifetime.
 *
 * https://docs.aws.amazon.com/lambda/latest/dg/runtimes-extensions-api.html
 */
export const registerLambdaExtension = async (): Promise<void> => {
  const api = process.env.AWS_LAMBDA_RUNTIME_API;
  if (!api) return;
  const base = `http://${api}/2020-01-01/extension`;
  try {
    const registration = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Lambda-Extension-Name": "alchemy-graceful-shutdown" },
      body: JSON.stringify({ events: [] }),
    });
    const extensionId = registration.headers.get("lambda-extension-identifier");
    if (extensionId) {
      void fetch(`${base}/event/next`, {
        headers: { "Lambda-Extension-Identifier": extensionId },
      }).catch(() => undefined);
    }
  } catch {
    // Not running on Lambda (or the Extensions API refused) — the function
    // still works, it just gets no shutdown window.
  }
};
