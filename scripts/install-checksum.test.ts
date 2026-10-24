import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Hex from "effect/encoding/Hex";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as NetAddress from "effect/net/NetAddress";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const INSTALL_CASES = ["home\\data", "home\ndata"].flatMap((homeName) =>
  [true, false].map((validChecksum) => ({ homeName, validChecksum })),
);

const verifyChecksum = Effect.fn("test.verifyInstallerChecksum")(
  function* ({
    checksumTool,
    homeName,
    validChecksum,
  }: (typeof INSTALL_CASES)[number] & { readonly checksumTool: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const server = yield* HttpServer.HttpServer;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-install-checksum-" });
    const tools = path.join(root, "tools");
    yield* fs.makeDirectory(tools);
    for (const command of [
      "sh",
      "uname",
      "tar",
      "gzip",
      "cut",
      "curl",
      "grep",
      "mkdir",
      "mktemp",
      "rm",
      "mv",
      "ln",
      checksumTool,
    ]) {
      const executable = yield* spawner.string(
        ChildProcess.make("sh", ["-c", 'command -v "$1"', "sh", command]),
      );
      yield* fs.symlink(executable.trim(), path.join(tools, command));
    }
    const t3Home = path.join(root, homeName);
    const version = "1.2.3";
    const stem = `t3-${version}-linux-${yield* HostProcess.Architecture}`;
    const archiveName = `${stem}.tar.gz`;
    yield* fs.makeDirectory(path.join(root, stem));
    yield* fs.writeFileString(path.join(root, stem, "t3"), "#!/bin/sh\necho 't3 v1.2.3'\n", {
      mode: 0o755,
    });
    const archivePath = path.join(root, archiveName);
    expect(
      yield* spawner.exitCode(ChildProcess.make("tar", ["-czf", archivePath, "-C", root, stem])),
    ).toBe(0);
    const archive = yield* fs.readFile(archivePath);
    const checksum = Hex.encode(yield* crypto.digest("SHA-256", archive));
    yield* server.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return request.url.endsWith("/SHA256SUMS")
          ? HttpServerResponse.text(
              `${validChecksum ? checksum : "0".repeat(64)}  ${archiveName}\n`,
            )
          : HttpServerResponse.uint8Array(archive);
      }),
    );
    if (!NetAddress.isInetAddress(server.address)) {
      return yield* Effect.die(new Error("Expected a TCP listener"));
    }
    const installer = yield* path.fromFileUrl(new URL("./install.sh", import.meta.url));
    const child = yield* spawner.spawn(
      ChildProcess.make("sh", [installer], {
        env: {
          ...(yield* HostProcess.Environment),
          PATH: tools,
          T3CODE_VERSION: version,
          T3CODE_HOME: t3Home,
          T3CODE_INSTALL_BIN_DIR: path.join(root, "bin"),
          T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${server.address.port}`,
        },
      }),
    );
    const [output, code] = yield* Effect.all(
      [
        Stream.merge(child.stdout, child.stderr).pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    const versions = path.join(t3Home, "runtime/versions");
    if (!validChecksum) {
      expect(code).not.toBe(0);
      expect(output).toContain("checksum mismatch");
      expect(output).not.toContain("Installed T3 Code");
      expect(yield* fs.readDirectory(versions)).toEqual([]);
    } else {
      expect(code, output).toBe(0);
      expect(output).toContain("Installed T3 Code 1.2.3");
      expect(yield* fs.readFileString(path.join(versions, version, ".install-complete"))).toBe(
        "1.2.3\n",
      );
      const launcher = yield* spawner.spawn(
        ChildProcess.make(path.join(root, "bin/t3"), ["--version"], { stderr: "ignore" }),
      );
      const [versionOutput, versionExit] = yield* Effect.all(
        [launcher.stdout.pipe(Stream.decodeText(), Stream.mkString), launcher.exitCode],
        { concurrency: "unbounded" },
      );
      expect(versionExit).toBe(0);
      expect(versionOutput.trim()).toBe("t3 v1.2.3");
      expect(yield* fs.readDirectory(versions)).toEqual([version]);
      expect(yield* fs.readFileString(path.join(t3Home, "runtime/launchers"))).toBe(
        `${path.join(root, "bin/t3")}\n`,
      );
    }
  },
  Effect.scoped,
  Effect.provide([NodeServices.layer, NodeHttpServer.layerTest]),
);

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer checksum", () => {
  it.live.each(INSTALL_CASES)(
    "verifies available checksum tools with home $homeName and valid checksum $validChecksum",
    (input) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const availableTools: string[] = [];
        for (const checksumTool of ["sha256sum", "shasum"]) {
          const executable = yield* spawner.string(
            ChildProcess.make("sh", ["-c", 'command -v "$1"', "sh", checksumTool]),
          );
          if (executable.trim()) availableTools.push(checksumTool);
        }
        expect(availableTools).not.toEqual([]);
        for (const checksumTool of availableTools) {
          yield* verifyChecksum({ ...input, checksumTool });
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
