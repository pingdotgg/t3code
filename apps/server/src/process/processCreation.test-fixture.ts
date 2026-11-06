/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker ports have no browser origin. */
// @effect-diagnostics nodeBuiltinImport:off -- an independent worker gates the real native process-creation boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeWorkerThreads from "node:worker_threads";

const { control, nativeOnly } = NodeWorkerThreads.workerData as {
  control: SharedArrayBuffer;
  nativeOnly?: boolean;
};
const barrier = new Int32Array(control);
const parent = NodeWorkerThreads.parentPort!;
const require = NodeModule.createRequire(import.meta.url);
const childProcesses = require("node:child_process") as typeof NodeChildProcess;
const workers = require("node:worker_threads") as typeof NodeWorkerThreads;
const spawn = childProcesses.spawn;
const Worker = workers.Worker;
const postMessage = workers.MessagePort.prototype.postMessage;
workers.MessagePort.prototype.postMessage = function (...args: Parameters<typeof postMessage>) {
  if (args[0] === "dispose") parent.postMessage({ type: "disposing" });
  return Reflect.apply(postMessage, this, args);
};

// The same native gate follows an eval worker without adding a production test hook.
const workerPrelude = `
{
  const cp = require("node:child_process");
  const { parentPort, workerData } = require("node:worker_threads");
  const spawn = cp.spawn;
  cp.spawn = function(command, args, options) {
    if (Array.isArray(args) && args.includes("t3-25245-spawn-gate")) {
      parentPort.postMessage({ type: "creation-blocked", serverThread: false });
      Atomics.wait(new Int32Array(workerData.creationGate), 0, 0);
    }
    const child = spawn(command, args, options);
    if (Array.isArray(args) && args.includes("t3-25245-spawn-gate")) {
      child.once("exit", () => parentPort.postMessage({ type: "child-exited" }));
    }
    return child;
  };
  require("node:module").syncBuiltinESMExports();
}
`;

childProcesses.spawn = ((...args: Parameters<typeof spawn>) => {
  if (Array.isArray(args[1]) && args[1].includes("t3-25245-spawn-gate")) {
    parent.postMessage({ type: "creation-blocked", serverThread: true });
    Atomics.wait(barrier, 0, 0);
  }
  return Reflect.apply(spawn, childProcesses, args);
}) as typeof spawn;

workers.Worker = class extends Worker {
  constructor(filename: string | URL, options?: NodeWorkerThreads.WorkerOptions) {
    super(
      options?.eval && typeof filename === "string" ? workerPrelude + filename : filename,
      options?.eval
        ? { ...options, workerData: { ...options.workerData, creationGate: control } }
        : options,
    );
    this.on("message", (event: { type?: string }) => {
      if (event.type === "creation-blocked" || event.type === "child-exited")
        parent.postMessage(event);
    });
  }
};
NodeModule.syncBuiltinESMExports();

const command = {
  command: process.execPath,
  args: ["-e", "process.stdout.write('finished')", "t3-25245-spawn-gate"],
};

const runner = await (async () => {
  if (nativeOnly) {
    return {
      run: () =>
        new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
          const child = childProcesses.spawn(command.command, command.args, { windowsHide: true });
          let stdout = "";
          child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
          child.once("error", reject);
          child.once("close", (code) => resolve({ stdout, code }));
        }),
      dispose: async () => {},
      cancel: async () => {},
    };
  }
  const [Effect, Layer, ManagedRuntime, NodeServices, ProcessRunner, Fiber] = await Promise.all([
    import("effect/Effect"),
    import("effect/Layer"),
    import("effect/ManagedRuntime"),
    import("@effect/platform-node/NodeServices"),
    import("../processRunner.ts"),
    import("effect/Fiber"),
  ]);
  const runtime = ManagedRuntime.make(ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)));
  let running: ReturnType<typeof runtime.runFork> | undefined;
  return {
    run: () => {
      const fiber = runtime.runFork(
        Effect.flatMap(ProcessRunner.ProcessRunner, (service) => service.run(command)),
      );
      running = fiber;
      return runtime.runPromise(Fiber.join(fiber));
    },
    cancel: () => (running ? runtime.runPromise(Fiber.interrupt(running)) : Promise.resolve()),
    dispose: () => runtime.dispose(),
  };
})();

const server = NodeHttp.createServer((request, response) => {
  if (request.url === "/cancel") {
    void runner.cancel().then(() => response.end("cancelled"));
    return;
  }
  if (request.url === "/probe") {
    response.end(JSON.stringify({ gateClosed: Atomics.load(barrier, 0) === 0 }));
    return;
  }
  void runner.run().then(
    (result) => response.end(JSON.stringify(result)),
    (error: unknown) => {
      response.statusCode = 500;
      response.end(String(error));
    },
  );
});
parent.once("message", () => {
  void runner.dispose().finally(() => {
    server.closeAllConnections();
    server.close(() => parent.close());
  });
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture address");
  parent.postMessage({ type: "listening", port: address.port });
});
