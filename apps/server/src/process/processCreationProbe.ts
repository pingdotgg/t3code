/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker ports have no browser origin. */
// @effect-diagnostics nodeBuiltinImport:off -- the test controller must remain independent of a synchronously blocked server.
import * as NodeHttp from "node:http";
import * as NodeWorkerThreads from "node:worker_threads";

const request = (port: number, path: string) =>
  new Promise<string>((resolve, reject) => {
    const request = NodeHttp.get(
      { hostname: "127.0.0.1", port, path, agent: false },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.once("end", () =>
          response.statusCode === 200 ? resolve(body) : reject(new Error(body)),
        );
        response.once("error", reject);
      },
    );
    request.once("error", reject);
  });

export async function probeProcessCreation(
  nativeOnly = false,
  cancel = false,
  failure?: { at: "disposing" | "child-exited"; mode: "error" | "exit" },
) {
  const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const barrier = new Int32Array(control);
  const listening = Promise.withResolvers<number>();
  const blocked = Promise.withResolvers<boolean>();
  const stopped = Promise.withResolvers<void>();
  const disposing = Promise.withResolvers<void>();
  const childExited = Promise.withResolvers<void>();
  const milestones = [listening, blocked, disposing, childExited];
  // A worker failure can precede acquisition of any of these milestones.
  for (const milestone of milestones) void milestone.promise.catch(() => {});
  const fail = (error: Error) => {
    for (const milestone of milestones) milestone.reject(error);
  };
  let stopping = false;
  const worker = new NodeWorkerThreads.Worker(
    new URL("./processCreation.test-fixture.ts", import.meta.url),
    {
      workerData: { control, nativeOnly, failure },
      execArgv: [],
    },
  );
  worker.on("message", (event: { type: string; port: number; serverThread: boolean }) => {
    if (event.type === "listening") listening.resolve(event.port);
    if (event.type === "creation-blocked") blocked.resolve(event.serverThread);
    if (event.type === "disposing") disposing.resolve();
    if (event.type === "child-exited") childExited.resolve();
  });
  worker.once("error", fail);
  worker.once("exit", (code) => {
    if (!stopping) fail(new Error(`Fixture worker exited unexpectedly (${code})`));
    stopped.resolve();
  });
  const release = () => {
    Atomics.store(barrier, 0, 1);
    Atomics.notify(barrier, 0);
  };
  let running: Promise<string> | undefined;
  let cancellation: Promise<string> | undefined;
  try {
    const port = await listening.promise;
    running = request(port, "/run");
    void running.catch(blocked.reject);
    const serverThread = await blocked.promise;
    // Native creation on the server cannot service the probe; release it so main fails without a timeout.
    if (serverThread) release();
    const probe = JSON.parse(await request(port, "/probe")) as { gateClosed: boolean };
    if (cancel && !serverThread) {
      cancellation = request(port, "/cancel");
      void cancellation.catch(() => {});
      await disposing.promise;
      release();
      await cancellation;
      if (failure?.at === "child-exited") worker.postMessage("fail-child-exit");
      await childExited.promise;
      await running.catch(() => {});
      return { serverThread, ...probe, stdout: "cancelled", code: null };
    }
    release();
    const result = JSON.parse(await running) as { stdout: string; code: number | null };
    return { serverThread, ...probe, stdout: result.stdout, code: result.code };
  } finally {
    release();
    await running?.catch(() => {});
    await cancellation?.catch(() => {});
    stopping = true;
    worker.postMessage("stop");
    await stopped.promise;
  }
}
