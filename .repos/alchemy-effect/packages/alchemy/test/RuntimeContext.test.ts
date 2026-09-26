import {
  packEnvValue,
  packEnvValueKeepRedacted,
  unpackEnvValue,
} from "@/RuntimeContext.ts";
import { describe, expect, it } from "alchemy-test";
import * as Redacted from "effect/Redacted";

describe("packEnvValue / unpackEnvValue", () => {
  it("stores a plain string verbatim (no quote characters on the wire)", () => {
    // #1243: a queue name must reach the env binding bare so raw readers
    // (dashboard, MessageBatch.queue comparisons) see the real name.
    expect(packEnvValue("my-queue")).toBe("my-queue");
    expect(packEnvValue("https://example.com/a?b=c")).toBe(
      "https://example.com/a?b=c",
    );
  });

  it("keeps ambiguous strings packed so the read side can't reinterpret them", () => {
    // These would JSON.parse into a different value if stored bare.
    for (const s of [
      "123",
      "-4.5",
      "null",
      "true",
      '"quoted"',
      '{"a":1}',
      "[1]",
    ]) {
      expect(packEnvValue(s)).toBe(JSON.stringify(s));
      expect(unpackEnvValue(packEnvValue(s))).toBe(s);
    }
  });

  it("round-trips every string exactly", () => {
    for (const s of [
      "my-queue",
      "",
      " ",
      "123",
      "null",
      "Infinity",
      '"unterminated',
      "{not json",
      "line\nbreak",
    ]) {
      expect(unpackEnvValue(packEnvValue(s))).toBe(s);
    }
  });

  it("round-trips non-string JSON values", () => {
    expect(unpackEnvValue(packEnvValue(8080))).toBe(8080);
    expect(unpackEnvValue(packEnvValue(true))).toBe(true);
    expect(unpackEnvValue(packEnvValue({ a: [1, "x"] }))).toEqual({
      a: [1, "x"],
    });
  });

  it("round-trips Redacted through the marker", () => {
    const out = unpackEnvValue<Redacted.Redacted<string>>(
      packEnvValue(Redacted.make("s3cret")),
    );
    expect(Redacted.isRedacted(out)).toBe(true);
    expect(Redacted.value(out!)).toBe("s3cret");
  });

  it("packEnvValueKeepRedacted keeps the wrapper outside the packed string", () => {
    const packed = packEnvValueKeepRedacted(Redacted.make("s3cret"));
    expect(Redacted.isRedacted(packed)).toBe(true);
    const inner = Redacted.value(packed as Redacted.Redacted<string>);
    const out = unpackEnvValue<Redacted.Redacted<string>>(inner);
    expect(Redacted.isRedacted(out)).toBe(true);
    expect(Redacted.value(out!)).toBe("s3cret");
    // Non-Redacted values stay plain strings.
    expect(packEnvValueKeepRedacted("my-queue")).toBe("my-queue");
  });

  it("unpackEnvValue passes through raw env vars a user set directly", () => {
    expect(unpackEnvValue("my-queue")).toBe("my-queue");
    expect(unpackEnvValue(undefined)).toBeUndefined();
    // A user-set raw numeric env var still parses — unchanged behavior.
    expect(unpackEnvValue("123")).toBe(123);
  });
});
