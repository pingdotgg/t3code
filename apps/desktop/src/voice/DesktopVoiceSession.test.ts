// @effect-diagnostics nodeBuiltinImport:off - Integration fixtures exercise a real native-helper subprocess and its temporary files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { DesktopVoiceSession } from "./DesktopVoiceSession.ts";

async function fixture(
  output = 'JSON.stringify({type:"transcript",text:"Hello world.",locale:"en_GB"})',
) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-test-"));
  const helper = NodePath.join(directory, "helper");
  await NodeFSP.writeFile(
    helper,
    `#!/usr/bin/env node
if (process.argv.includes('--probe')) { console.log('{"type":"available"}'); process.exit(0); }
require('node:fs').writeFileSync(require('node:path').join(process.argv[3], 'audio'), 'temporary audio');
require('node:fs').writeFileSync(process.argv[1] + '.audio-path', process.argv[3]);
console.log('{"type":"recording","locale":"en_GB"}');
process.stdin.once('data', () => { console.log(${output}); process.exit(0); });
`,
    { mode: 0o755 },
  );
  const session = new DesktopVoiceSession(helper);
  return {
    session,
    recordingDirectory: () => NodeFSP.readFile(helper + ".audio-path", "utf8"),
    async [Symbol.asyncDispose]() {
      await session.dispose();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    },
  };
}

it("records, finishes, and rejects requests from another window or an old draft", async () => {
  await using test = await fixture();
  expect(await test.session.available()).toBe(true);
  const ready = Promise.withResolvers<void>();
  const result = test.session.start(1, "first", ready.resolve);
  await ready.promise;
  await expect(test.session.start(2, "other", () => {})).rejects.toThrow("already active");
  expect(() => test.session.stop(2, "first")).toThrow("no longer active");
  await test.session.cancel(1, "old");
  const audioDirectory = await test.recordingDirectory();
  test.session.stop(1, "first");
  await expect(result).resolves.toEqual({ text: "Hello world.", locale: "en_GB" });
  await expect(NodeFSP.access(audioDirectory)).rejects.toThrow("ENOENT");
  expect(() => test.session.stop(1, "first")).toThrow("no longer active");
});

it("can cancel during preparation and immediately reuse the helper after cleanup", async () => {
  await using test = await fixture();
  const result = test.session.start(1, "first", () => {});
  const rejected = expect(result).rejects.toThrow("cancelled");
  await test.session.cancel(1, "first");
  await rejected;
  const ready = Promise.withResolvers<void>();
  const second = test.session.start(1, "second", ready.resolve);
  await ready.promise;
  const cancelled = expect(second).rejects.toThrow("cancelled");
  await test.session.cancel(1);
  await cancelled;
});

it.each([
  ['JSON.stringify({type:"error",message:"Microphone denied"})', "Microphone denied"],
  ['JSON.stringify({type:"transcript",text:42,locale:"en"})', "Expected"],
  ['"not json"', "Expected"],
])("reports helper failures without returning a transcript: %s", async (output, message) => {
  await using test = await fixture(output);
  const ready = Promise.withResolvers<void>();
  const result = test.session.start(1, "first", ready.resolve);
  const rejected = expect(result).rejects.toThrow(message);
  await ready.promise;
  test.session.stop(1, "first");
  await rejected;
});

it("treats unsupported platforms and missing helpers as unavailable", async () => {
  const session = new DesktopVoiceSession(null);
  expect(await session.available()).toBe(false);
  await expect(session.start(1, "first", () => {})).rejects.toThrow("unavailable");
  const missing = new DesktopVoiceSession("/missing/t3-voice-input");
  expect(await missing.available()).toBe(false);
  await expect(missing.start(1, "first", () => {})).rejects.toThrow("ENOENT");
});
