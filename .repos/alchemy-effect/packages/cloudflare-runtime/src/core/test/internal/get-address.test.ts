import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeHttp from "node:http";
import { getAddress, toConnectableHost } from "../../internal/get-address.ts";

const listen = (host?: string) =>
  Effect.acquireRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer();
      server.once("error", (error) => resume(Effect.die(error)));
      if (host === undefined) {
        server.listen(0, () => resume(Effect.succeed(server)));
      } else {
        server.listen(0, host, () => resume(Effect.succeed(server)));
      }
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

describe("toConnectableHost", () => {
  it("never returns a connect target on the unspecified address", () => {
    // Connecting to a listen-all address works on Linux/macOS ("this host")
    // but fails on Windows (ConnectEx ERROR_DUP_NAME #52). Every address we
    // hand to workerd as an external service target goes through this
    // normalization, so listen-all hosts must always come back as loopback.
    expect(toConnectableHost("0.0.0.0")).toBe("127.0.0.1");
    expect(toConnectableHost("::")).toBe("127.0.0.1");
    expect(toConnectableHost("::0")).toBe("127.0.0.1");
    expect(toConnectableHost("0000:0000:0000:0000:0000:0000:0000:0000")).toBe(
      "127.0.0.1",
    );
  });

  it("passes concrete hosts through unchanged", () => {
    expect(toConnectableHost("127.0.0.1")).toBe("127.0.0.1");
    expect(toConnectableHost("::1")).toBe("::1");
    expect(toConnectableHost("192.168.1.10")).toBe("192.168.1.10");
    expect(toConnectableHost("localhost")).toBe("localhost");
  });
});

describe("getAddress", () => {
  it.effect(
    "maps a server bound to 0.0.0.0 to a 127.0.0.1 connect target",
    () =>
      Effect.gen(function* () {
        const server = yield* listen("0.0.0.0");
        const address = yield* getAddress(server);
        expect(address).toMatch(/^127\.0\.0\.1:\d+$/);
      }),
  );

  it.effect(
    "maps a server bound with no host (dual-stack) to a 127.0.0.1 connect target",
    () =>
      Effect.gen(function* () {
        const server = yield* listen();
        const address = yield* getAddress(server);
        expect(address).toMatch(/^127\.0\.0\.1:\d+$/);
      }),
  );

  it.effect("keeps an explicit 127.0.0.1 bind unchanged", () =>
    Effect.gen(function* () {
      const server = yield* listen("127.0.0.1");
      const address = yield* getAddress(server);
      expect(address).toMatch(/^127\.0\.0\.1:\d+$/);
    }),
  );
});
