import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// On macOS, Node can bind 127.0.0.1:<port> while another process (such as the
// desktop app with network access on) listens on *:<port>. Linux refuses that
// bind unless both sockets set SO_REUSEPORT, so on Linux the preload adds it to
// the picker's probe and the holder sets it too. macOS needs neither.
const MACOS_BIND_PRELOAD = `const net = require("node:net");
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (port, host, callback) {
  if (typeof port !== "number" || typeof host !== "string") return listen.apply(this, arguments);
  return listen.call(this, { port, host, reusePort: true }, callback);
};
`;

describe("__ssh-helper pick-port", () => {
  const hostPlatform = HostProcess.Platform.defaultValue();
  const linuxHost = hostPlatform === "linux";
  const windowsHost = hostPlatform === "win32";

  const holdWildcardPort = Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer((socket) => socket.destroy());
      server.once("error", (error) => resume(Effect.die(error)));
      server.listen({ port: 0, host: "0.0.0.0", reusePort: linuxHost }, () =>
        resume(Effect.succeed(server)),
      );
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

  it.effect.skipIf(windowsHost)(
    "skips a port another server answers on loopback",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pick-port-" });
        yield* fs.writeFileString(`${root}/preload.cjs`, MACOS_BIND_PRELOAD);
        const holder = yield* holdWildcardPort;
        const heldPort = (holder.address() as NodeNet.AddressInfo).port;

        const child = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [
            ...(linuxHost ? ["--require", `${root}/preload.cjs`] : []),
            "--experimental-strip-types",
            new URL("../bin.ts", import.meta.url).pathname,
            "__ssh-helper",
            "pick-port",
            "",
            String(heldPort),
            "20",
          ]),
        );
        const [stdout, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(
              Stream.decodeText(),
              Stream.runFold(
                () => "",
                (acc, chunk) => acc + chunk,
              ),
            ),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );

        assert.equal(exitCode, 0);
        const picked = Number(stdout);
        assert.isAbove(picked, heldPort);
        assert.isBelow(picked, heldPort + 20);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30_000,
  );
});
