import { assert, beforeEach, expect, it, vi } from "vite-plus/test";

const { createFromBufferMock, execFileMock, readFileMock, writeFileMock } = vi.hoisted(() => ({
  createFromBufferMock: vi.fn(),
  execFileMock: vi.fn(),
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("node:fs/promises", () => ({ readFile: readFileMock, writeFile: writeFileMock }));
vi.mock("electron", () => ({ nativeImage: { createFromBuffer: createFromBufferMock } }));

import { captureMacWindowSnapshot, macSnapShotArguments } from "./MacSnapShot.ts";

beforeEach(() => {
  execFileMock
    .mockReset()
    .mockImplementation(
      (
        _path: string,
        _args: ReadonlyArray<string>,
        _options: { readonly timeout: number },
        callback: (error: Error | null) => void,
      ) => callback(null),
    );
  readFileMock.mockReset();
  writeFileMock.mockReset();
  createFromBufferMock.mockReset().mockReturnValue({
    getSize: () => ({ width: 100, height: 80 }),
    isEmpty: () => false,
  });
});

it("captures one macOS window directly as a silent shadowless PNG", async () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("image"),
  ]);
  readFileMock.mockResolvedValue(png);
  const active = {
    id: 42,
    title: "Editor",
    owner: { name: "Code" },
  } as Parameters<typeof captureMacWindowSnapshot>[0];

  const capture = await captureMacWindowSnapshot(active, "/tmp/window.png", {
    width: 100,
    height: 80,
  });

  assert.deepEqual(execFileMock.mock.calls[0]?.slice(0, 3), [
    "/usr/sbin/screencapture",
    macSnapShotArguments(42, "/tmp/window.png"),
    { timeout: 15_000 },
  ]);
  assert.deepEqual(readFileMock.mock.calls, [["/tmp/window.png"]]);
  assert.lengthOf(writeFileMock.mock.calls, 0);
  assert.strictEqual(capture.png, png);
  assert.deepEqual(capture.source, { name: "Editor" });
});

it("bounds Retina captures without changing their aspect ratio", async () => {
  const capturedPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("retina"),
  ]);
  const resizedPng = Buffer.from("bounded png");
  const resizeMock = vi.fn().mockReturnValue({ toPNG: () => resizedPng });
  readFileMock.mockResolvedValue(capturedPng);
  createFromBufferMock.mockReturnValue({
    getSize: () => ({ width: 2_000, height: 1_200 }),
    isEmpty: () => false,
    resize: resizeMock,
  });
  const active = {
    id: 42,
    title: "Editor",
    owner: { name: "Code" },
  } as Parameters<typeof captureMacWindowSnapshot>[0];

  const capture = await captureMacWindowSnapshot(active, "/tmp/window.png", {
    width: 1_000,
    height: 1_000,
  });

  assert.deepEqual(resizeMock.mock.calls, [[{ width: 1_000, height: 600, quality: "best" }]]);
  assert.deepEqual(writeFileMock.mock.calls, [["/tmp/window.png", resizedPng]]);
  assert.strictEqual(capture.png, resizedPng);
});

it("rejects a successful command that did not produce a PNG", async () => {
  readFileMock.mockResolvedValue(Buffer.from("not a png"));
  const active = {
    id: 42,
    title: "",
    owner: { name: "Code" },
  } as Parameters<typeof captureMacWindowSnapshot>[0];

  await expect(
    captureMacWindowSnapshot(active, "/tmp/window.png", { width: 100, height: 80 }),
  ).rejects.toThrow("macOS returned an invalid snapshot.");
});
