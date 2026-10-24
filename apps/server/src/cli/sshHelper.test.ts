import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { renderBootServicePlist, renderBootServiceUnit } from "../cloud/bootService.ts";
import { resolveSshServerHome } from "./sshHelper.ts";

it.effect.each(["linux", "darwin"] as const)(
  "resolves the %s service home and gives an explicit environment home precedence",
  (platform) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-helper-test-" });
      const serviceHome = path.join(directory, 'T3 "Data" & 100%');
      const servicePath =
        platform === "darwin"
          ? path.join(directory, "Library/LaunchAgents/com.t3tools.t3code.service.plist")
          : path.join(directory, ".config/systemd/user/t3code.service");
      const resolve = (environment: NodeJS.ProcessEnv = {}) =>
        resolveSshServerHome.pipe(
          Effect.provideService(HostProcess.HomeDirectory, directory),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.Environment, environment),
        );
      assert.strictEqual(yield* resolve(), path.join(directory, ".t3"));
      const plan = {
        baseDir: serviceHome,
        program: ["/fake/t3"],
        logPath: "/fake/log",
        unitPath: servicePath,
      };
      yield* fs.makeDirectory(path.dirname(servicePath), { recursive: true });
      yield* fs.writeFileString(
        servicePath,
        platform === "darwin"
          ? renderBootServicePlist(plan, { homeDir: directory, environmentPath: "" })
          : renderBootServiceUnit(plan),
      );
      assert.strictEqual(yield* resolve(), serviceHome);
      assert.strictEqual(
        yield* resolve({ T3CODE_HOME: "~/explicit home" }),
        path.join(directory, "explicit home"),
      );
      assert.strictEqual(yield* resolve({ T3CODE_HOME: " " }), serviceHome);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
