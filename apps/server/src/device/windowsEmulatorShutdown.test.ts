import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { prepareWindowsEmulatorShutdown } from "./windowsEmulatorShutdown.ts";

const result = (code: number, stdout = "") => Effect.succeed({ code, stdout, stderr: "" });

it.effect("captures an exact hub child before allowing a targeted tree shutdown", () =>
  Effect.gen(function* () {
    const run = vi
      .fn()
      .mockReturnValueOnce(result(0, "123:42:456\r\n"))
      .mockReturnValueOnce(result(0));
    const recover = yield* prepareWindowsEmulatorShutdown(run, 19, "emulator-5554");
    if (recover === null) throw new Error("Expected a captured owner");
    const capture = Buffer.from(run.mock.calls[0]![1].at(-1), "base64").toString("utf16le");
    expect(capture).toContain("ParentProcessId = 19");
    expect(capture).toContain('"?5554"?(?=\\s|$)');
    expect(capture).not.toContain("taskkill.exe");
    expect(yield* recover()).toBe(true);
    const cleanup = Buffer.from(run.mock.calls[1]![1].at(-1), "base64").toString("utf16le");
    expect(cleanup).toContain("$identity -ne '123:42:456'");
    expect(cleanup).toContain("/PID $owner.ProcessId /T /F");
  }),
);

it.effect("skips physical devices and declines shutdown when ownership is unavailable", () =>
  Effect.gen(function* () {
    const run = vi.fn().mockReturnValue(result(1));
    expect(yield* prepareWindowsEmulatorShutdown(run, 19, "phone")).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(yield* prepareWindowsEmulatorShutdown(run, 19, "emulator-5554")).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  }),
);
