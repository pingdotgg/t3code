import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverSshHosts } from "./config.ts";

it.effect("preserves distinct known-host ports and IPv6 destinations", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homeDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-known-host-ports-" });
    const sshDir = path.join(homeDir, ".ssh");
    yield* fs.makeDirectory(sshDir);
    yield* fs.writeFileString(
      path.join(sshDir, "known_hosts"),
      [
        "host.example.com ssh-ed25519 AAAA",
        "[host.example.com]:2222 ssh-ed25519 AAAA",
        "[host.example.com]:2223 ssh-ed25519 AAAA",
        "[host.example.com]:2222 ssh-rsa BBBB",
        "[2001:db8::1]:2200 ssh-ed25519 AAAA",
        "[invalid.example.com]:65536 ssh-ed25519 AAAA",
      ].join("\n"),
    );
    const hosts = yield* discoverSshHosts({ homeDir });
    assert.deepEqual(
      hosts.map(({ alias, hostname, port }) => ({ alias, hostname, port })),
      [
        { alias: "host.example.com", hostname: "host.example.com", port: null },
        { alias: "ssh://[2001:db8::1]:2200", hostname: "2001:db8::1", port: 2200 },
        { alias: "ssh://host.example.com:2222", hostname: "host.example.com", port: 2222 },
        { alias: "ssh://host.example.com:2223", hostname: "host.example.com", port: 2223 },
      ],
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
