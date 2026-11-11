import * as NodeNet from "node:net";
import * as NodeOs from "node:os";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import * as Port from "../../internal/Port.ts";
import * as PortHelpers from "../helpers/port.ts";

// First: `find` reserves ports process-wide, and the OS hands out ephemeral
// ports in sequence, so a later `check` could see a reservation instead.
describe("Port.check", () => {
  // macOS lets a loopback bind coexist with a wildcard listener on the same
  // port, so only an attempt to connect over loopback finds one.
  it.effect("treats a port held by a wildcard listener as in use", () =>
    Effect.gen(function* () {
      for (const host of ["0.0.0.0", "::"]) {
        const ports = yield* Port.make({ cache: false });
        const { port, held } = yield* Effect.scoped(
          Effect.gen(function* () {
            const { port } = yield* PortHelpers.occupy(0, host);
            return { port, held: yield* Effect.result(ports.check(port)) };
          }),
        );
        expect({ host, held: held._tag }).toEqual({ host, held: "Failure" });
        // Free again once the listener closes: the listener, not a
        // reservation, made the port unavailable.
        expect(yield* ports.check(port)).toBe(port);
      }
    }),
  );

  // A listener on another interface doesn't hold the loopback port.
  const lanAddress = Object.values(NodeOs.networkInterfaces())
    .flat()
    .find((address) => address?.family === "IPv4" && !address.internal)?.address;
  it.effect.skipIf(lanAddress === undefined)(
    "treats a port held only on another interface as available",
    () =>
      Effect.gen(function* () {
        const occupied = yield* PortHelpers.occupy(0, lanAddress);
        const ports = yield* Port.make({ cache: false });
        expect(yield* ports.check(occupied.port)).toBe(occupied.port);
      }),
  );

  // Windows retries a refused connection before reporting it, so a connect
  // probe of a free port waits for its timeout there.
  it.effect("checks a free port quickly", () =>
    Effect.gen(function* () {
      const port = yield* (yield* Port.make({ cache: false })).find(0);
      const ports = yield* Port.make({ cache: false });
      const start = performance.now();
      yield* ports.check(port);
      expect(performance.now() - start).toBeLessThan(300);
    }),
  );

  it.effect("probes only loopback addresses", () =>
    Effect.gen(function* () {
      const ports = yield* Port.make({ cache: false });
      const listen = vi.spyOn(NodeNet.Server.prototype, "listen");
      try {
        yield* ports.check(Number(process.env.PORT ?? 0));
        expect(
          listen.mock.calls.map(([options]) => (options as NodeNet.ListenOptions).host),
        ).toEqual(["localhost", "127.0.0.1", "::1", "0000:0000:0000:0000:0000:0000:0000:0001"]);
      } finally {
        listen.mockRestore();
      }
    }),
  );
});

const occupyBelowEphemeralRange = Effect.gen(function* () {
  const base = 20_000 + Math.floor(Math.random() * 10_000);
  for (let port = base; port < base + 100; port++) {
    const occupied = yield* Effect.exit(PortHelpers.occupy(port, "127.0.0.1"));
    if (occupied._tag === "Success") return occupied.value;
  }
  return yield* Effect.die(`no free port in ${base}-${base + 99}`);
});

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
      // Occupy a port below every OS's ephemeral range. Windows hands out
      // ephemeral ports in sequence, so a scan starting just past an
      // ephemeral port collides with its own connect probes' client ports.
      const occupied = yield* occupyBelowEphemeralRange;
      const ports = yield* Port.make({ cache: false });
      const next = yield* ports.find(occupied.port);
      expect(next).toBeGreaterThan(occupied.port);
    }),
  );
});

describe("Port.isUnsupportedHostError", () => {
  it("recognizes coded unsupported-host errors", () => {
    expect(Port.isUnsupportedHostError({ code: "EAFNOSUPPORT" }, "::1", true)).toBe(true);
  });

  it("does not mistake a coded address conflict for an unsupported host", () => {
    expect(Port.isUnsupportedHostError({ code: "EADDRINUSE" }, "::1", false)).toBe(false);
  });

  it("recognizes Bun's uncoded IPv6 failure when IPv6 is unavailable", () => {
    expect(Port.isUnsupportedHostError(new Error("Failed to listen at ::"), "::", false)).toBe(
      true,
    );
  });

  it("does not ignore an uncoded IPv6 failure on a dual-stack machine", () => {
    expect(Port.isUnsupportedHostError(new Error("Failed to listen at ::"), "::", true)).toBe(
      false,
    );
  });

  it("does not mistake an uncoded IPv4 failure for an unsupported host", () => {
    expect(
      Port.isUnsupportedHostError(new Error("Failed to listen at 0.0.0.0"), "0.0.0.0", false),
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
