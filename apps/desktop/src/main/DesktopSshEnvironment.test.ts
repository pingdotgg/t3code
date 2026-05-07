import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import { SshPasswordPromptError } from "@t3tools/ssh/errors";
import { Effect, FileSystem, Layer, Path } from "effect";

import * as DesktopSshEnvironment from "./DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import { SSH_PASSWORD_PROMPT_CANCELLED_RESULT } from "../ipc/channels.ts";
import { discoverSshHosts, ensureSshEnvironment } from "../ipc/methods/sshEnvironment.ts";

function makeTempHomeDir() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-env-test-" });
  });
}

class TestIpcMain implements DesktopIpc.DesktopIpcMain {
  readonly handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  handle(channel: string, listener: DesktopIpc.DesktopIpcHandleListener): void {
    this.handlers.set(channel, listener);
  }

  removeAllListeners(): void {}

  on(): void {}
}

describe("sshEnvironment", () => {
  it("treats password prompt timeouts as cancellable authentication prompts", () => {
    assert.equal(
      DesktopSshEnvironment.isDesktopSshPasswordPromptCancellation(
        new SshPasswordPromptError({
          message: "SSH authentication timed out for devbox.",
          cause: new DesktopSshPasswordPrompts.DesktopSshPromptTimedOutError({
            requestId: "prompt-1",
            destination: "devbox",
          }),
        }),
      ),
      true,
    );
  });

  it.effect("wires desktop host discovery through the ssh package runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* makeTempHomeDir();
      const sshDir = path.join(homeDir, ".ssh");
      yield* fs.makeDirectory(path.join(sshDir, "config.d"), { recursive: true });
      yield* fs.writeFileString(
        path.join(sshDir, "config"),
        ["Host devbox", "  HostName devbox.example.com", "Include config.d/*.conf", ""].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(sshDir, "config.d", "team.conf"),
        [
          "Host staging",
          "  HostName staging.example.com",
          "Host *",
          "  ServerAliveInterval 30",
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(sshDir, "known_hosts"),
        [
          "known.example.com ssh-ed25519 AAAA",
          "|1|hashed|entry ssh-ed25519 AAAA",
          "[bastion.example.com]:2222 ssh-ed25519 AAAA",
          "",
        ].join("\n"),
      );

      const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
      const hosts = yield* sshEnvironment.discoverHosts({ homeDir });
      assert.deepEqual(hosts, [
        {
          alias: "bastion.example.com",
          hostname: "bastion.example.com",
          username: null,
          port: null,
          source: "known-hosts",
        },
        {
          alias: "devbox",
          hostname: "devbox",
          username: null,
          port: null,
          source: "ssh-config",
        },
        {
          alias: "known.example.com",
          hostname: "known.example.com",
          username: null,
          port: null,
          source: "known-hosts",
        },
        {
          alias: "staging",
          hostname: "staging",
          username: null,
          port: null,
          source: "ssh-config",
        },
      ]);
    }).pipe(
      Effect.provide(
        DesktopSshEnvironment.layer().pipe(
          Layer.provideMerge(
            Layer.succeed(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
              request: () => Effect.die("unexpected password prompt request"),
              resolve: () => Effect.die("unexpected password prompt resolution"),
              cancelPending: () => Effect.void,
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(NodeHttpClient.layerUndici),
          Layer.provideMerge(NetService.layer),
        ),
      ),
      Effect.scoped,
    ),
  );

  it.effect("runs SSH IPC handlers with the captured Effect context", () =>
    Effect.gen(function* () {
      const ipcMain = new TestIpcMain();
      const ipc = DesktopIpc.make(ipcMain);

      yield* ipc.handle(discoverSshHosts);

      const discoverHosts = ipcMain.handlers.get("desktop:discover-ssh-hosts");
      assert.ok(discoverHosts);

      const hosts = yield* Effect.promise(() => Promise.resolve(discoverHosts({}, undefined)));
      assert.deepEqual(hosts, [
        {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: null,
          port: null,
          source: "ssh-config",
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            DesktopSshEnvironment.DesktopSshEnvironment,
            DesktopSshEnvironment.DesktopSshEnvironment.of({
              discoverHosts: () =>
                Effect.succeed([
                  {
                    alias: "devbox",
                    hostname: "devbox.example.com",
                    username: null,
                    port: null,
                    source: "ssh-config" as const,
                  },
                ]),
              ensureEnvironment: () => Effect.die("unexpected ensureEnvironment"),
              disconnectEnvironment: () => Effect.die("unexpected disconnectEnvironment"),
            }),
          ),
          NodeServices.layer,
        ),
      ),
      Effect.scoped,
    ),
  );

  it.effect("encodes SSH password prompt cancellations as typed IPC results", () =>
    Effect.gen(function* () {
      const result = yield* ensureSshEnvironment.handler({
        target: {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: null,
          port: null,
        },
        options: { issuePairingToken: true },
      });

      assert.deepEqual(result, {
        type: SSH_PASSWORD_PROMPT_CANCELLED_RESULT,
        message: "SSH authentication timed out for devbox.",
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            DesktopSshEnvironment.DesktopSshEnvironment,
            DesktopSshEnvironment.DesktopSshEnvironment.of({
              discoverHosts: () => Effect.die("unexpected discoverHosts"),
              ensureEnvironment: () =>
                Effect.fail(
                  new SshPasswordPromptError({
                    message: "SSH authentication timed out for devbox.",
                    cause: new DesktopSshPasswordPrompts.DesktopSshPromptTimedOutError({
                      requestId: "prompt-1",
                      destination: "devbox",
                    }),
                  }),
                ),
              disconnectEnvironment: () => Effect.die("unexpected disconnectEnvironment"),
            }),
          ),
          NodeServices.layer,
        ),
      ),
    ),
  );
});
