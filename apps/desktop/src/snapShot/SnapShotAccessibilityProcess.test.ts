import { assert, beforeEach, it } from "@effect/vitest";
import * as NodeEvents from "node:events";
import { vi } from "vite-plus/test";

const forkMock = vi.hoisted(() =>
  vi.fn<
    (
      _path: string,
      _args: ReadonlyArray<string>,
      _options: { env?: NodeJS.ProcessEnv; execPath?: string },
    ) => unknown
  >(),
);

vi.mock("node:child_process", () => ({ fork: forkMock }));

import {
  makeSnapShotAccessibilityProcessPool,
  startSnapShotAccessibilityProcess,
} from "./SnapShotAccessibilityProcess.ts";

const makeWorker = () =>
  Object.assign(new NodeEvents.EventEmitter(), {
    kill: vi.fn(() => true),
    send: vi.fn(),
  });
let worker = makeWorker();
const request = {
  active: {
    title: "Zoom Meeting",
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    owner: { processId: 42 },
  },
  platform: "darwin" as const,
  sourceTitle: "Zoom Meeting",
  imageSize: { width: 1_600, height: 1_200 },
};

beforeEach(() => {
  worker = makeWorker();
  forkMock.mockReset().mockReturnValue(worker);
});

it("keeps T3 alive when Zoom crashes accessibility extraction", async () => {
  const process = startSnapShotAccessibilityProcess("accessibility.cjs");
  const read = process.read(request);
  worker.emit("message", "ready");
  worker.emit("message", "started");
  await read.started;
  worker.emit("exit", null, "SIGABRT");

  assert.isUndefined(await read.result);
});

it("returns immediately when accessibility crashes before the screenshot is ready", async () => {
  const process = startSnapShotAccessibilityProcess("accessibility.cjs");
  worker.emit("exit", null, "SIGABRT");

  const read = process.read(request);
  await read.started;
  assert.isUndefined(await read.result);
});

it("replaces a warm helper that exits before capture", async () => {
  const exitedWorker = makeWorker();
  const captureWorker = makeWorker();
  const replacementWorker = makeWorker();
  forkMock
    .mockReset()
    .mockReturnValueOnce(exitedWorker)
    .mockReturnValueOnce(captureWorker)
    .mockReturnValueOnce(replacementWorker);
  const pool = makeSnapShotAccessibilityProcessPool("accessibility.cjs");

  pool.warm();
  exitedWorker.emit("exit", 1);
  const read = pool.read(request);
  captureWorker.emit("message", "ready");
  captureWorker.emit("message", "started");
  captureWorker.emit("message", { type: "result", context: { accessibleText: "Recovered" } });

  assert.deepEqual(await read.result, { accessibleText: "Recovered" });
  assert.lengthOf(forkMock.mock.calls, 3);
  assert.deepEqual(captureWorker.send.mock.calls[0]?.[0], request);
  pool.close();
});
