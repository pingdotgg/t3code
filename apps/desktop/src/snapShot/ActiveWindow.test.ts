import * as NodeEvents from "node:events";

import { assert, expect, it, vi } from "vite-plus/test";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("../electron/WindowsForeground.ts", () => ({ loadWindowsForegroundApi: vi.fn() }));

import { activeWindow } from "./ActiveWindow.ts";

it("feeds the macOS lookup script to osascript over stdin instead of inline", async () => {
  const lookup = {
    id: 42,
    title: "main.ts",
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    owner: {
      name: "Editor",
      processId: 123,
      path: "/Applications/Editor.app",
      bundleId: "com.example.editor",
    },
  };
  const stdin = { on: vi.fn(), end: vi.fn() };
  execFileMock.mockImplementation(
    (
      file: string,
      args: ReadonlyArray<string>,
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      assert.strictEqual(file, "/usr/bin/osascript");
      assert.deepEqual(args, ["-l", "JavaScript", "-"]);
      stdin.end.mockImplementation(() => callback(null, JSON.stringify(lookup) + "\n"));
      return { stdin };
    },
  );

  assert.deepEqual(await activeWindow("darwin"), { platform: "macos", ...lookup });

  assert.lengthOf(stdin.end.mock.calls, 1);
  assert.include(stdin.end.mock.calls[0]![0], "CGWindowListCopyWindowInfo");
});

it("reports the process failure when osascript exits before reading stdin", async () => {
  const failure = Object.assign(new Error("osascript was killed"), { signal: "SIGKILL" });
  const stdin = new NodeEvents.EventEmitter();
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: ReadonlyArray<string>,
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => ({
      stdin: Object.assign(stdin, {
        end() {
          stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
          callback(failure, "");
        },
      }),
    }),
  );

  await expect(activeWindow("darwin")).rejects.toBe(failure);
});
