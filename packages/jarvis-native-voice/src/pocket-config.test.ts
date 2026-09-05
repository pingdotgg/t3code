import { assert, describe, it } from "@effect/vitest";

import {
  bundledPocketVoicePaths,
  pocketDaemonName,
  pocketInferenceThreads,
  pocketMaxChunkFrames,
  pocketFirstChunkFrames,
  pocketMaxTokenPerChunk,
  pocketOnsetMaxTrimMs,
  pocketOnsetPrerollMs,
  pocketOnsetThresholdDbfs,
  pocketPinnedExports,
  pocketPinnedOrt,
  pocketPinnedRuntime,
  pocketResourceError,
  pocketSampleRate,
  pocketTemperature,
  pocketVoicePaths,
} from "./pocket-config.ts";

describe("Pocket configuration", () => {
  it("pins the measured runtime, models, and voice setup", () => {
    assert.equal(pocketPinnedRuntime, "e801e7d6c2692121a39e80ae525cb5265174a495");
    assert.equal(pocketPinnedExports, "fc68ee7e5a0a29662e218df84b24acb311f7fb6d");
    assert.equal(pocketPinnedOrt, "1.23.2");
    assert.equal(pocketSampleRate, 24_000);
    assert.equal(pocketTemperature, 0.3);
    assert.equal(pocketInferenceThreads, 2);
    assert.equal(pocketFirstChunkFrames, 1);
    assert.equal(pocketMaxChunkFrames, 3);
    assert.equal(pocketMaxTokenPerChunk, 50);
    assert.equal(pocketOnsetThresholdDbfs, -50);
    assert.equal(pocketOnsetPrerollMs, 40);
    assert.equal(pocketOnsetMaxTrimMs, 2_000);
  });

  it("resolves pocket paths without touching the retired kokoro directory", () => {
    const paths = pocketVoicePaths("/voices/pocket");
    assert.equal(paths.voiceFile, "/voices/pocket/voices/alba-casual-3s.wav");
    assert.equal(paths.daemonPath, `/voices/pocket/bin/${pocketDaemonName()}`);
    assert.notInclude(paths.resourceRoot, "kokoro");
  });

  it("reports a reinstall error when the daemon or voice is missing", () => {
    const failure = pocketResourceError(bundledPocketVoicePaths("/definitely/missing"));
    assert.instanceOf(failure, Error);
    assert.match((failure as Error).message, /Reinstall Jarvis/u);
  });
});
