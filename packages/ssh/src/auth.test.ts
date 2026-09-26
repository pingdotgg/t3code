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
  isSshPasswordRetryable,
} from "./auth.ts";

describe("ssh auth", () => {
  it("does not offer a password retry when a key-only host's agent fails", () => {
    const error = new Error(
      [
        'sign_and_send_pubkey: signing failed for ED25519 "key.pub" from agent: communication with agent failed',
        "dev@10.13.37.3: Permission denied (publickey).",
      ].join("\n"),
    );
    assert.isTrue(isSshAuthFailure(error));
    assert.isFalse(isSshPasswordRetryable(error));
  });

  it.each([
    ["Permission denied (publickey).", false],
    ["Permission denied (hostbased,gssapi-with-mic).", false],
    ["Permission denied (password).", true],
    ["Permission denied (keyboard-interactive).", true],
    ["Permission denied (publickey,password,keyboard-interactive).", true],
    ["Permission denied (PASSWORD, publickey).", true],
    ["Permission denied (publickey,password-expired).", false],
    ["Authentication failed", false],
    ["Too many authentication failures", false],
    ["Connection timed out", false],
  ])("checks the offered methods in %s", (message, expected) => {
    assert.equal(isSshPasswordRetryable(new Error(message)), expected);
    assert.equal(isSshPasswordRetryable(message), expected);
  });

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
