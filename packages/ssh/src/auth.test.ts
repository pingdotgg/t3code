import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  buildSshAskpassHelperDescriptor,
  buildSshChildEnvironment,
  isSshAuthFailure,
} from "./auth.ts";
import * as SshErrors from "./errors.ts";

describe("ssh auth", () => {
  it.effect("detects ssh auth failures from common permission denied messages", () =>
    Effect.sync(() => {
      assert.equal(
        isSshAuthFailure(
          new Error(
            "julius@100.65.180.100: Permission denied (publickey,password,keyboard-interactive).",
          ),
        ),
        true,
      );
      assert.equal(isSshAuthFailure(new Error("Permission denied (publickey).")), true);
      assert.equal(isSshAuthFailure(new Error("Connection timed out")), false);
      assert.equal(isSshAuthFailure(new Error("mkdir: Permission denied")), false);
    }),
  );

  it("only follows causes from SSH process wrappers", () => {
    const authFailure = new Error("Permission denied (publickey,password).");
    const commandFailure = new SshErrors.SshCommandSpawnError({
      command: "ssh",
      argumentCount: 1,
      exitCode: null,
      stderrBytes: 0,
      target: "devbox",
      cause: authFailure,
    });
    assert.equal(isSshAuthFailure(commandFailure), true);

    const helperFailure = new SshErrors.SshAuthenticationHelperError({
      command: "ssh",
      argumentCount: 1,
      exitCode: null,
      stderrBytes: 0,
      target: "devbox",
      cause: authFailure,
    });
    assert.equal(isSshAuthFailure(helperFailure), false);

    const readinessFailure = new SshErrors.SshReadinessTimeoutError({
      base: {
        protocol: "http:",
        hostname: "127.0.0.1",
        port: "41773",
        urlLength: 23,
        pathnameLength: 1,
        hasQuery: false,
        hasFragment: false,
      },
      request: {
        protocol: "http:",
        hostname: "127.0.0.1",
        port: "41773",
        urlLength: 28,
        pathnameLength: 6,
        hasQuery: false,
        hasFragment: false,
      },
      timeoutMs: 1_000,
      attempts: 1,
      cause: new SshErrors.SshReadinessProbeError({
        request: {
          protocol: "http:",
          hostname: "127.0.0.1",
          port: "41773",
          urlLength: 28,
          pathnameLength: 6,
          hasQuery: false,
          hasFragment: false,
        },
        cause: new Error("HTTP authentication failed."),
      }),
    });
    assert.equal(isSshAuthFailure(readinessFailure), false);
  });

  it.effect("creates askpass env for cached password prompts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-askpass-test-" });
      const env = yield* buildSshChildEnvironment({
        authSecret: "super-secret",
        interactiveAuth: true,
        askpassDirectory: directory,
        baseEnv: {},
      });

      const askpassPath = path.join(directory, "ssh-askpass.sh");
      assert.equal(env.SSH_ASKPASS, askpassPath);
      assert.equal(env.SSH_ASKPASS_REQUIRE, "force");
      assert.equal(env.T3_SSH_AUTH_SECRET, "super-secret");
      assert.equal(env.DISPLAY, "t3code");
      assert.equal(yield* fs.exists(askpassPath), true);
      assert.include(yield* fs.readFileString(askpassPath), 'printf "%s\\n" "$T3_SSH_AUTH_SECRET"');
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, Layer.succeed(HostProcessPlatform, "linux"))),
      Effect.scoped,
    ),
  );

  it.effect("builds a windows askpass launcher pair", () =>
    Effect.gen(function* () {
      const descriptor = yield* buildSshAskpassHelperDescriptor({
        directory: "C:\\temp\\t3code-ssh-askpass",
      }).pipe(
        Effect.provide(
          Layer.merge(NodeServices.layer, Layer.succeed(HostProcessPlatform, "win32")),
        ),
      );

      assert.equal(descriptor.launcherPath, "C:\\temp\\t3code-ssh-askpass\\ssh-askpass.cmd");
      assert.deepEqual(
        descriptor.files.map((file) => file.path.split("\\").at(-1)),
        ["ssh-askpass.cmd", "ssh-askpass.ps1"],
      );
    }),
  );
});
