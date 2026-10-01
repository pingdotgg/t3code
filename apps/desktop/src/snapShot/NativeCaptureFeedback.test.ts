// @effect-diagnostics nodeBuiltinImport:off -- Isolated child-process streams; no desktop session is touched.
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
import { startNativeCaptureFeedback } from "./NativeCaptureFeedback.ts";

const options = {
  bounds: { x: -800, y: 0, width: 800, height: 600 },
  pid: 123,
  flash: true,
  animate: true,
};
let child: NodeEvents.EventEmitter & {
  stdin: NodeStream.PassThrough;
  stdout: NodeStream.PassThrough;
  kill: ReturnType<typeof vi.fn>;
};
let commands: string[];
beforeEach(() => {
  vi.useFakeTimers();
  commands = [];
  child = Object.assign(new NodeEvents.EventEmitter(), {
    stdin: new NodeStream.PassThrough(),
    stdout: new NodeStream.PassThrough(),
    kill: vi.fn(),
  });
  child.stdin.on("data", (value: Buffer) => commands.push(value.toString()));
  spawn.mockReturnValue(child);
});
afterEach(() => {
  child.emit("close");
  vi.useRealTimers();
});
function event(value: unknown) {
  child.stdout.write(`${JSON.stringify(value)}\n`);
}

it("waits for compositor readiness and landing, then waits for cleanup on acknowledgement", async () => {
  const starting = startNativeCaptureFeedback("/helper", "/private", options);
  let ready = false;
  void starting.then(() => {
    ready = true;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  event({ event: "ready", animate: true });
  const feedback = (await starting)!;
  expect(feedback.animationStarted).toBe(true);
  const frame = { x: 0.1, y: 0.7, width: 0.2, height: 0.1 };
  const flight = feedback.animateTo('My "Draft"', frame);
  let completed = false;
  const complete = feedback.complete().then(() => {
    completed = true;
  });
  expect(commands.map((line) => JSON.parse(line))).toEqual([
    { command: "animate", title: 'My "Draft"', frame },
  ]);
  event({ event: "landed" });
  await flight;
  expect(commands.map((line) => JSON.parse(line))).toHaveLength(2);
  expect(completed).toBe(false);
  child.emit("close");
  await complete;
  expect(completed).toBe(true);
  expect(child.kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("doesn't claim a flight when the compositor disables motion; flash still works", async () => {
  const starting = startNativeCaptureFeedback("/helper", "/private", options);
  event({ event: "ready", animate: false });
  const feedback = (await starting)!;
  expect(feedback.animationStarted).toBe(false);
  await feedback.animateTo("Draft", { x: 0, y: 0, width: 1, height: 1 });
  expect(commands).toEqual([]);
  const complete = feedback.complete();
  child.emit("close");
  await complete;
});

it("falls back on startup failure, malformed replies, and timeout without leaving timers", async () => {
  const starting = startNativeCaptureFeedback("/helper", "/private", options);
  child.stdout.write("not JSON\n");
  expect(commands).toEqual(['{"command":"close"}\n']);
  await vi.advanceTimersByTimeAsync(1000);
  expect(child.kill).toHaveBeenCalledOnce();
  child.emit("close");
  expect(await starting).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds a missing ready receipt and cancels an in-flight animation on compositor failure", async () => {
  const timed = startNativeCaptureFeedback("/helper", "/private", options);
  await vi.advanceTimersByTimeAsync(2000);
  child.emit("close");
  expect(await timed).toBeUndefined();
});

it("releases waiters if the overlay closes during flight", async () => {
  const starting = startNativeCaptureFeedback("/helper", "/private", options);
  event({ event: "ready", animate: true });
  const feedback = (await starting)!;
  const flight = feedback.animateTo("Draft", { x: 0, y: 0, width: 1, height: 1 });
  event({ event: "done" });
  await flight;
  child.emit("close");
  await feedback.complete();
  expect(vi.getTimerCount()).toBe(0);
});
