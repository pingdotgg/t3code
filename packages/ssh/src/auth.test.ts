import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { buildSshChildEnvironment, isSshAgentSigningFailure, isSshAuthFailure } from "./auth.ts";

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

  it.effect("detects agent signing failures from current and pre-8.2 OpenSSH", () =>
    Effect.sync(() => {
      const denied = "julius@devbox: Permission denied (publickey,password).";
      assert.isTrue(
        isSshAgentSigningFailure(
          new Error(
            `sign_and_send_pubkey: signing failed for ED25519 "/home/julius/.ssh/id_ed25519" from agent: communication with agent failed\r\n${denied}`,
          ),
        ),
      );
      assert.isTrue(
        isSshAgentSigningFailure(
          new Error(`sign_and_send_pubkey: signing failed: agent refused operation\n${denied}`),
        ),
      );
      assert.isFalse(
        isSshAgentSigningFailure(
          new Error(
            `sign_and_send_pubkey: signing failed for ED25519-SK "/home/julius/.ssh/id_ed25519_sk": device not found\n${denied}`,
          ),
        ),
      );
      assert.isFalse(isSshAgentSigningFailure(new Error(denied)));
    }),
  );

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
      Effect.provide(Layer.merge(NodeServices.layer, Layer.succeed(HostProcess.Platform, "linux"))),
      Effect.scoped,
    ),
  );
});
