// Regression tests for the bounded streaming onset filter. Ported from the
// measured onset study: the filter must remove only the leading-silence
// prefix, preserve quiet attacks with preroll, keep every later pause, and
// return an exact suffix across variable chunk boundaries.
import { assert, describe, it } from "@effect/vitest";

import { createPocketOnsetFilter } from "./pocket-onset.ts";

const zeros = (count: number): Float32Array => new Float32Array(count);
const full = (count: number, value: number): Float32Array => {
  const samples = new Float32Array(count);
  samples.fill(value);
  return samples;
};
const concat = (parts: ReadonlyArray<Float32Array>): Float32Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

describe("Pocket onset filter", () => {
  it("emits during generation and keeps the quiet attack plus preroll", () => {
    const gate = createPocketOnsetFilter({ sampleRate: 1000 });
    assert.isUndefined(gate.push(zeros(100)));
    const attack = full(20, 0.0001);
    const speech = full(80, 0.1);
    const output = gate.push(concat([zeros(20), attack, speech]));
    assert.isDefined(output);
    assert.deepEqual(Array.from(output!.slice(-100)), Array.from(concat([attack, speech])));
    assert.isAtLeast(output!.length, 110);
    const continuation = zeros(100);
    assert.strictEqual(gate.push(continuation), continuation);
  });

  it("preserves speech on the first sample", () => {
    const gate = createPocketOnsetFilter({ sampleRate: 1000 });
    const pcm = full(80, 0.1);
    assert.deepEqual(gate.push(pcm), pcm);
    assert.equal(gate.droppedSamples(), 0);
  });

  it("does not lose an onset across a chunk boundary", () => {
    const gate = createPocketOnsetFilter({ sampleRate: 1000 });
    assert.isUndefined(gate.push(concat([zeros(100), full(4, 0.001)])));
    const output = gate.push(full(20, 0.01));
    assert.isDefined(output);
    assert.deepEqual(
      Array.from(output!.slice(-24)),
      Array.from(concat([full(4, 0.001), full(20, 0.01)])),
    );
  });

  it("bounds silence removal and preserves tiny outputs", () => {
    const gate = createPocketOnsetFilter({ sampleRate: 1000, maxTrimMs: 100 });
    assert.isDefined(gate.push(zeros(100)));
    const tiny = createPocketOnsetFilter({ sampleRate: 1000 });
    assert.isUndefined(tiny.push(full(3, 1)));
    assert.deepEqual(tiny.finish(), full(3, 1));
  });

  it("does not open on a quiet decoder transient", () => {
    const gate = createPocketOnsetFilter({
      sampleRate: 1000,
      thresholdDbfs: -50,
      prerollMs: 40,
    });
    assert.isUndefined(gate.push(concat([full(5, 0.002), zeros(195)])));
    const speech = concat([zeros(100), full(10, 0.0005), full(100, 0.1)]);
    const output = gate.push(speech);
    assert.isDefined(output);
    assert.deepEqual(Array.from(output!.slice(-110)), Array.from(speech.slice(-110)));
    assert.isAbove(gate.droppedSamples(), 200);
  });

  it("returns an exact suffix across variable chunk boundaries", () => {
    let seed = 23;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return (seed / 2_147_483_648) * 2 - 1;
    };
    for (const size of [13, 1920, 5760, 28_800]) {
      const noise = new Float32Array(40_000);
      for (let index = 0; index < noise.length; index += 1) noise[index] = random() * 0.03;
      const original = concat([zeros(17_000), noise]);
      const gate = createPocketOnsetFilter({ thresholdDbfs: -50, prerollMs: 40 });
      const outputs: Array<Float32Array> = [];
      for (let offset = 0; offset < original.length; offset += size) {
        const chunk = gate.push(original.slice(offset, offset + size));
        if (chunk !== undefined && chunk.length > 0) outputs.push(chunk);
      }
      const tail = gate.finish();
      if (tail.length > 0) outputs.push(tail);
      assert.deepEqual(concat(outputs), original.slice(gate.droppedSamples()));
    }
  });

  it("preserves every pause after the gate opens", () => {
    const gate = createPocketOnsetFilter({ sampleRate: 1000 });
    const first = gate.push(full(50, 0.2));
    assert.isDefined(first);
    const pause = zeros(500);
    assert.strictEqual(gate.push(pause), pause);
    const second = full(50, 0.2);
    assert.strictEqual(gate.push(second), second);
  });
});
