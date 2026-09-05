// @effect-diagnostics nodeBuiltinImport:off - tmp chunk files mirror the packaged native exchange.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { encodeWavFloat32Mono, readWavFloat32Mono } from "./pocket-wav.ts";

describe("Pocket WAV chunks", () => {
  it("round-trips float32 mono PCM", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "jarvis-pocket-wav-"));
    try {
      const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0.0001]);
      const path = NodePath.join(directory, "chunk-000000.wav");
      await NodeFSP.writeFile(path, encodeWavFloat32Mono(samples, 24_000));
      const decoded = await readWavFloat32Mono(path);
      assert.equal(decoded.sampleRate, 24_000);
      assert.deepEqual(Array.from(decoded.samples), Array.from(samples));
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects non-WAV bytes instead of playing silence as success", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "jarvis-pocket-wav-"));
    try {
      const path = NodePath.join(directory, "chunk-000000.wav");
      await NodeFSP.writeFile(path, Buffer.from("not-a-wav"));
      const failure = await readWavFloat32Mono(path).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      assert.instanceOf(failure, Error);
      assert.match((failure as Error).message, /invalid WAV/u);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
