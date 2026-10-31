import * as NodeNet from "node:net";

import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fileBasename } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import * as WindowsTcpListeners from "./WindowsTcpListeners.ts";

it.effect("reads native Windows IPv4/IPv6 wildcard and loopback listeners and process names", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "win32") return;
    const ports: number[] = [];
    for (const host of ["127.0.0.1", "0.0.0.0", "::1", "::"]) {
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => NodeNet.createServer()),
        (server) =>
          Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen({ host, port: 0, ipv6Only: true }, resolve);
          }),
      );
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing TCP address");
      ports.push(address.port);
    }
    const native = yield* WindowsTcpListeners.WindowsTcpListeners;
    const rows = yield* native.scan;
    for (const port of ports) expect(rows).toContainEqual({ port, pid: process.pid });
    expect(yield* native.processName(process.pid)).toBe(
      fileBasename(process.execPath).replace(/\.exe$/i, ""),
    );
    expect(yield* native.processName(0)).toBeNull();
  }).pipe(Effect.provide(WindowsTcpListeners.layer)),
);
