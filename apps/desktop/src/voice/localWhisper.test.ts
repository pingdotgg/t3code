// @effect-diagnostics nodeBuiltinImport:off
// Exercise the native process adapter and its private temporary files through its Promise API.
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { LocalWhisper, runWhisperProcess, validateDictationWav } from "./localWhisper.ts";
const directories: string[] = [];
async function directory() {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-dictation-test-"));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of directories.splice(0)) await NodeFSP.rm(dir, { recursive: true, force: true });
});
describe("local whisper backend", () => {
  it("reports a missing executable without downloading anything", async () => {
    let downloads = 0;
    const manager = new LocalWhisper(await directory(), "linux", async () => {
      downloads++;
      return new Response();
    });
    const state = await manager.execute({ action: "status" }, 1, "/missing/whisper-cli");
    expect(state.state).toBe("unavailable");
    expect(downloads).toBe(0);
  });
  it("rejects a bad model checksum and removes partial files", async () => {
    const dir = await directory();
    let downloads = 0;
    const manager = new LocalWhisper(dir, "linux", async () => {
      downloads++;
      return new Response(new Uint8Array([1, 2, 3]));
    });
    const state = await manager.execute(
      { action: "install", operationId: "install" },
      1,
      "/missing/whisper-cli",
    );
    expect(state.state).toBe("failed");
    expect(state.message).toContain("checksum");
    expect(downloads).toBe(1);
    expect(await NodeFSP.readdir(dir)).toEqual([]);
  });
  it("cancels the owned download, rejects concurrent writes, and cleans temporary files", async () => {
    const dir = await directory();
    let enter!: () => void;
    const started = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const manager = new LocalWhisper(
      dir,
      "linux",
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          enter();
          init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const downloading = manager.execute(
      { action: "install", operationId: "one" },
      1,
      "/missing/whisper-cli",
    );
    await started;
    expect((await manager.execute({ action: "install", operationId: "two" }, 2, "")).state).toBe(
      "unavailable",
    );
    await manager.execute({ action: "cancel", operationId: "wrong" }, 1, "");
    expect((await manager.execute({ action: "status" }, 2, "")).state).toBe("downloading");
    manager.cancelOwner(1);
    await manager.dispose();
    expect((await downloading).state).toBe("cancelled");
    expect(await NodeFSP.readdir(dir)).toEqual([]);
  });
  it("does not accept malformed or oversized recordings", () => {
    expect(() => validateDictationWav(new Uint8Array(100))).toThrow("format");
    expect(() => validateDictationWav(new Uint8Array(10_000_000))).toThrow("Recording");
  });
  it("terminates only the inference child it owns on cancellation", async () => {
    const abort = new AbortController();
    const result = runWhisperProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      abort.signal,
      10000,
    );
    abort.abort();
    await expect(result).rejects.toThrow("Cancelled");
  });
});
