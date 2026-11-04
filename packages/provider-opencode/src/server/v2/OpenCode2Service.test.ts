import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect, vi } from "vite-plus/test";

import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";
import { replaceOutdatedService } from "./OpenCode2Service.ts";

const service = vi.hoisted(() => ({ incumbent: vi.fn(), ensure: vi.fn() }));
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
      yield* fileSystem.makeDirectory(path.join(home, ".config", "opencode"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(home, ".config", "opencode", "service.json"),
        JSON.stringify({ env: { CONFIGURED: "yes", XDG_STATE_HOME: "/elsewhere" } }),
      );
      const file = path.join(home, ".local", "state", "opencode", "service.json");
      const run = (binary: string) =>
        replaceOutdatedService({
          binaryPath: "/bin/opencode",
          serverUrl: "http://127.0.0.1:49374",
          environment: { HOME: home },
        }).pipe(
          Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtimeWithBinaryVersion(binary)),
        );
      service.ensure.mockReturnValue(Effect.void);

      service.incumbent.mockReturnValue(Effect.succeed({ state: "ready" }));
      yield* run("opencode v1.18.32");
      expect(service.incumbent).not.toHaveBeenCalled();

      service.incumbent.mockReturnValue(Effect.undefined);
      yield* run("opencode v2.2.5");
      expect(service.incumbent).toHaveBeenCalledWith({ file, url: "http://127.0.0.1:49374" });
      expect(service.ensure).not.toHaveBeenCalled();

      service.incumbent.mockReturnValue(Effect.succeed({ state: "ready" }));
      yield* run("opencode v2.2.5");
      expect(service.ensure).toHaveBeenCalledWith({
        file,
        version: "2.2.5",
        command: ["/bin/opencode", "serve", "--service"],
        env: { HOME: home, CONFIGURED: "yes" },
      });
    }).pipe(Effect.scoped),
  );
});
