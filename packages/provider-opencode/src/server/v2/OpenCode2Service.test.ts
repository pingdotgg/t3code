import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect, vi } from "vite-plus/test";

import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";
import { replaceOutdatedService } from "./OpenCode2Service.ts";

const service = vi.hoisted(() => ({ discover: vi.fn(), ensure: vi.fn() }));
vi.mock("@opencode/client/effect/service", () => ({ Service: service }));

const runtimeWithBinaryVersion = (stdout: string) =>
  ({
    runOpenCodeCommand: () => Effect.succeed({ stdout, stderr: "", code: 0 }),
  }) as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"];

it.layer(NodeServices.layer)("replaceOutdatedService", (it) => {
  it.effect("replaces only this install's 2.x service, keeping its configured env", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      const binDirectory = path.join(home, "bin");
      yield* fileSystem.makeDirectory(binDirectory);
      yield* fileSystem.writeFileString(path.join(binDirectory, "opencode"), "");
      yield* fileSystem.chmod(path.join(binDirectory, "opencode"), 0o755);
      const environment = { HOME: home, PATH: binDirectory, OPENCODE_CONFIG_DIR: home };
      yield* fileSystem.writeFileString(
        path.join(home, "service.json"),
        JSON.stringify({ env: { PATH: "/nowhere", XDG_STATE_HOME: "/elsewhere" } }),
      );
      const file = path.join(home, ".local", "state", "opencode", "service.json");
      const run = (binary: string, serverUrl = "http://127.0.0.1:49374") =>
        replaceOutdatedService({
          binaryPath: "opencode",
          serverUrl,
          environment,
        }).pipe(
          Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtimeWithBinaryVersion(binary)),
        );
      service.ensure.mockReturnValue(Effect.void);

      service.discover.mockReturnValue(Effect.succeed({ url: "http://0.0.0.0:49374" }));
      yield* run("opencode v1.18.32");
      expect(service.discover).not.toHaveBeenCalled();

      for (const elsewhere of ["http://192.168.1.5:49374", "http://127.0.0.1:49999"]) {
        yield* run("opencode v2.2.5", elsewhere);
      }
      expect(service.discover).toHaveBeenCalledWith({ file });
      expect(service.ensure).not.toHaveBeenCalled();

      service.discover.mockReturnValue(Effect.undefined);
      yield* run("opencode v2.2.5");
      expect(service.ensure).not.toHaveBeenCalled();

      service.discover.mockReturnValue(Effect.succeed({ url: "http://0.0.0.0:49374" }));
      yield* run("opencode v2.2.5");
      expect(service.ensure).toHaveBeenCalledWith({
        file,
        version: "2.2.5",
        command: [path.join(binDirectory, "opencode"), "serve", "--service"],
        env: { ...environment, PATH: "/nowhere" },
      });
    }).pipe(Effect.scoped),
  );
});
