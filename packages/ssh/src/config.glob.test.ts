import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { discoverSshHosts } from "./config.ts";

it.effect("discovers Include matches across wildcard directory components", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homeDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-glob-" });
    const ssh = path.join(homeDir, ".ssh");
    yield* fs.makeDirectory(ssh);
    yield* fs.writeFileString(
      path.join(ssh, "config"),
      "Include teams/*/hosts?.conf\nInclude absent/*/config\nHost local\n",
    );
    for (const team of ["one", "two"]) {
      const directory = path.join(ssh, "teams", team);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(path.join(directory, "hosts1.conf"), `Host ${team}\n`);
      yield* fs.writeFileString(path.join(directory, "hosts12.conf"), "Host excluded\n");
    }
    yield* fs.writeFileString(path.join(ssh, "teams", "not-a-directory"), "ignored");
    yield* fs.makeDirectory(path.join(ssh, "teams", "one", "hosts2.conf"));
    const hosts = yield* discoverSshHosts({ homeDir });
    assert.deepEqual(
      hosts.map((host) => host.alias),
      ["local", "one", "two"],
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
