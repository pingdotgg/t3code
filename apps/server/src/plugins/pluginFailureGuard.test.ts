import { assert, it } from "@effect/vitest";
import { PluginId } from "@t3tools/contracts";

import { pluginCodeScope } from "./api/facade.ts";
import { makePluginFailureGuard } from "./pluginFailureGuard.ts";

const leaky = PluginId.make("leaky");

/** Takes the runner's crash listeners off, which would report the fake crashes below as real. */
const withoutRunnerListeners = () => {
  const exceptions = process.listeners("uncaughtException");
  const rejections = process.listeners("unhandledRejection");
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");
  return {
    [Symbol.dispose]: () => {
      process.removeAllListeners("uncaughtException");
      process.removeAllListeners("unhandledRejection");
      for (const listener of exceptions) process.on("uncaughtException", listener);
      for (const listener of rejections) process.on("unhandledRejection", listener);
    },
  };
};

/** A guard watching the `leaky` plugin, with what it recorded. */
const watchLeaky = () => {
  const rejected: Array<string> = [];
  const crashed: Array<string> = [];
  const guard = makePluginFailureGuard({
    onRejection: (pluginId) => rejected.push(pluginId),
    onCrash: (pluginId) => crashed.push(pluginId),
  });
  guard.watch("/plugins/leaky/", leaky);
  return { rejected, crashed, uninstall: guard.uninstall, [Symbol.dispose]: guard.uninstall };
};

const pluginError = (message: string) => {
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at /plugins/leaky/server.cjs:1:1`;
  return error;
};

// As Node reports a rejection nobody handled.
const reject = (reason: Error) => process.emit("unhandledRejection", reason, Promise.resolve());
const messageOf = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

it("records a plugin's uncaught exception and leaves the exit to Node", () => {
  using _runner = withoutRunnerListeners();
  using guard = watchLeaky();

  // Node tells the monitor before the listeners, or its own exit when there are none.
  process.emit("uncaughtExceptionMonitor", pluginError("thrown in a timer"));
  process.emit("uncaughtExceptionMonitor", new Error("T3 crashed"));

  assert.deepStrictEqual(guard.crashed, ["leaky"]);
  // It adds no listener, so Node, or a guard that exits only while it listens alone, still exits.
  assert.strictEqual(process.listenerCount("uncaughtException"), 0);
  guard.uninstall();
  assert.strictEqual(process.listenerCount("uncaughtExceptionMonitor"), 0);
});

it("hands T3's own rejections to a listener added after it, and only those", async () => {
  using _runner = withoutRunnerListeners();
  using guard = watchLeaky();
  const seen: Array<string> = [];
  // Such as a provider SDK's guard, when its layer builds after a plugin started.
  const late = (reason: unknown) => seen.push(messageOf(reason));
  process.on("unhandledRejection", late);
  await Promise.resolve();

  reject(pluginError("rejected in a timer"));
  reject(new Error("T3 rejected"));

  assert.deepStrictEqual(guard.rejected, ["leaky"]);
  assert.deepStrictEqual(seen, ["T3 rejected"]);
  // It listens alone, so a guard that acts only then still does.
  assert.strictEqual(process.listenerCount("unhandledRejection"), 1);
  guard.uninstall();
  assert.deepStrictEqual(process.listeners("unhandledRejection"), [late]);
});

it("calls a listener added with once for one rejection", () => {
  using _runner = withoutRunnerListeners();
  const seen: Array<string> = [];
  process.once("unhandledRejection", (reason) => seen.push(messageOf(reason)));
  using _guard = watchLeaky();

  reject(new Error("first"));
  // With nothing else listening, the second stops the server as Node would.
  assert.throws(() => reject(new Error("second")), "second");
  assert.deepStrictEqual(seen, ["first"]);
});

it("stops calling a listener its owner removes", () => {
  using _runner = withoutRunnerListeners();
  const seen: Array<string> = [];
  const listener = (reason: unknown) => seen.push(messageOf(reason));
  process.on("unhandledRejection", listener);
  using _guard = watchLeaky();

  process.off("unhandledRejection", listener);

  assert.throws(() => reject(new Error("T3 rejected")), "T3 rejected");
  assert.deepStrictEqual(seen, []);
});

it("stops calling a plugin's own listener once the plugin removes it on disable", async () => {
  using _runner = withoutRunnerListeners();
  using _guard = watchLeaky();
  const seen: Array<string> = [];
  const listener = (reason: unknown) => seen.push(messageOf(reason));
  // As the plugin's `activate`, then its `onDeactivate`.
  pluginCodeScope.run(leaky, () => process.on("unhandledRejection", listener));
  await Promise.resolve();
  process.off("unhandledRejection", listener);

  assert.throws(() => reject(new Error("T3 rejected")), "T3 rejected");
  assert.deepStrictEqual(seen, []);
});
