import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { makeThreadFindTextCache, TextKey } from "./ThreadFindTextCache.ts";

function key(text: string, overrides: Partial<TextKey> = {}) {
  return new TextKey({
    text,
    role: "assistant",
    streaming: false,
    hasContext: false,
    cwd: undefined,
    skills: [],
    ...overrides,
  });
}

it.effect("evicts parsed text by combined source and rendered size, not just entry count", () =>
  Effect.gen(function* () {
    let parses = 0;
    const cache = yield* makeThreadFindTextCache((input) => {
      parses++;
      return [input.text];
    });
    const keys = Array.from({ length: 200 }, (_, index) => key(`${index}:` + "x".repeat(32_000)));
    for (const input of keys) yield* cache.get(input);
    assert.equal(parses, keys.length);
    yield* cache.get(keys.at(-1)!);
    assert.equal(parses, keys.length);
    yield* cache.get(keys[0]!);
    assert.equal(parses, keys.length + 1);
  }),
);

it.effect("does not let one oversized entry displace reusable small messages", () =>
  Effect.gen(function* () {
    let parses = 0;
    const cache = yield* makeThreadFindTextCache((input) => {
      parses++;
      return [input.text];
    });
    const small = key("needle");
    const large = key("needle " + "x".repeat(5 * 1024 * 1024));
    const expected = yield* cache.get(small);
    assert.deepEqual(yield* cache.get(large), [large.text]);
    assert.deepEqual(yield* cache.get(large), [large.text]);
    assert.strictEqual(yield* cache.get(key("needle")), expected);
    assert.equal(parses, 3);
  }),
);

it.effect("includes display context and parsed expansion in the retention budget", () =>
  Effect.gen(function* () {
    let parses = 0;
    const cache = yield* makeThreadFindTextCache(() => {
      parses++;
      return ["x".repeat(9 * 1024 * 1024)];
    });
    yield* cache.get(key("short source"));
    yield* cache.get(key("short source"));
    assert.equal(parses, 2);
    const contextual = yield* makeThreadFindTextCache((input) => {
      parses++;
      return [input.text];
    });
    const input = key("x".repeat(200_000), {
      skills: Array.from({ length: 1000 }, () => ({
        name: "x".repeat(200),
        displayName: "x".repeat(200),
      })),
    });
    yield* contextual.get(input);
    yield* contextual.get(input);
    assert.equal(parses, 4);
  }),
);

it.effect("reuses equal keys until expiry and keeps display variants distinct", () =>
  Effect.gen(function* () {
    let parses = 0;
    const cache = yield* makeThreadFindTextCache((input) => [String(++parses), input.text]);
    const original = yield* cache.get(key("needle"));
    assert.strictEqual(yield* cache.get(key("needle")), original);
    for (const overrides of [
      { role: "plan" as const },
      { streaming: true },
      { hasContext: true },
      { cwd: "/different" },
      { skills: [{ name: "skill", displayName: "Skill" }] },
      { skills: [{ name: "skill" }] },
    ]) {
      assert.notStrictEqual(yield* cache.get(key("needle", overrides)), original);
    }
    yield* TestClock.adjust("1 minute");
    assert.notStrictEqual(yield* cache.get(key("needle")), original);
    assert.equal(parses, 8);
  }),
);

it.effect("keeps recently reused messages while evicting older parses", () =>
  Effect.gen(function* () {
    let parses = 0;
    const cache = yield* makeThreadFindTextCache((input) => {
      parses++;
      return [input.text];
    });
    const keys = Array.from({ length: 140 }, (_, index) => key(`${index}:` + "x".repeat(32_000)));
    for (const input of keys.slice(0, 120)) yield* cache.get(input);
    const recent = yield* cache.get(keys[0]!);
    for (const input of keys.slice(120)) yield* cache.get(input);
    assert.strictEqual(yield* cache.get(keys[0]!), recent);
    assert.equal(parses, keys.length);
    yield* cache.get(keys[1]!);
    assert.equal(parses, keys.length + 1);
  }),
);
