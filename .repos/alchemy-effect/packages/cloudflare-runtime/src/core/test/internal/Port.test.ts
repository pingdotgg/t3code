import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Port from "../../internal/Port.ts";
import * as PortHelpers from "../helpers/port.ts";

describe("Port.find", () => {
  it.effect("returns a free port when the requested port is 0", () =>
    Effect.gen(function* () {
      const ports = yield* Port.make({ cache: false });
      const port = yield* ports.find(0);
      expect(port).toBeGreaterThanOrEqual(0);
    }),
  );

  it.effect("returns the requested port when free", () =>
    Effect.gen(function* () {
      const ports = yield* Port.make({ cache: false });
      const selected = yield* ports.find(0);
      const port = yield* ports.find(selected);
      expect(port).toBe(selected);
    }).pipe(it.flakyTest),
  );

  it.effect("skips a port in use and returns the next available one", () =>
    Effect.gen(function* () {
      const occupied = yield* PortHelpers.occupy(0);
      const ports = yield* Port.make({ cache: false });
      const next = yield* ports.find(occupied.port);
      expect(next).toBeGreaterThan(occupied.port);
    }),
  );
});

describe("Port.isUnsupportedHostError", () => {
  it("recognizes coded unsupported-host errors", () => {
    expect(
      Port.isUnsupportedHostError({ code: "EAFNOSUPPORT" }, "::1", true),
    ).toBe(true);
  });

  it("does not mistake a coded address conflict for an unsupported host", () => {
    expect(
      Port.isUnsupportedHostError({ code: "EADDRINUSE" }, "::1", false),
    ).toBe(false);
  });

  it("recognizes Bun's uncoded IPv6 failure when IPv6 is unavailable", () => {
    expect(
      Port.isUnsupportedHostError(
        new Error("Failed to listen at ::"),
        "::",
        false,
      ),
    ).toBe(true);
  });

  it("does not ignore an uncoded IPv6 failure on a dual-stack machine", () => {
    expect(
      Port.isUnsupportedHostError(
        new Error("Failed to listen at ::"),
        "::",
        true,
      ),
    ).toBe(false);
  });

  it("does not mistake an uncoded IPv4 failure for an unsupported host", () => {
    expect(
      Port.isUnsupportedHostError(
        new Error("Failed to listen at 0.0.0.0"),
        "0.0.0.0",
        false,
      ),
    ).toBe(false);
  });
});

describe("Port.viteSupportsPortZero", () => {
  it("accepts 8.2.1 and later", () => {
    expect(Port.viteSupportsPortZero("8.2.1")).toBe(true);
    expect(Port.viteSupportsPortZero("8.2.2")).toBe(true);
    expect(Port.viteSupportsPortZero("8.3.0")).toBe(true);
    expect(Port.viteSupportsPortZero("9.0.0")).toBe(true);
    expect(Port.viteSupportsPortZero("9.0.0-beta.1")).toBe(true);
  });

  it("rejects versions before 8.2.1", () => {
    expect(Port.viteSupportsPortZero("8.2.0")).toBe(false);
    expect(Port.viteSupportsPortZero("8.1.9")).toBe(false);
    expect(Port.viteSupportsPortZero("7.2.6")).toBe(false);
    expect(Port.viteSupportsPortZero("6.0.0")).toBe(false);
  });

  it("rejects missing or malformed versions", () => {
    expect(Port.viteSupportsPortZero(undefined)).toBe(false);
    expect(Port.viteSupportsPortZero(null)).toBe(false);
    expect(Port.viteSupportsPortZero("")).toBe(false);
    expect(Port.viteSupportsPortZero("next")).toBe(false);
  });
});
