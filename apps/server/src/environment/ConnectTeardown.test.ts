import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ConnectTeardown from "./ConnectTeardown.ts";
import * as ServerEnvironment from "./ServerEnvironment.ts";

const layerTest = ConnectTeardown.layer.pipe(
  Layer.provideMerge(Layer.merge(SessionStore.layer, PairingGrantStore.layer)),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("teardown-environment")),
    }),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-connect-teardown-" })),
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("ConnectTeardown", (it) => {
  it.effect("removes only T3 Connect's leftovers, and a second run changes nothing", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const sessions = yield* SessionStore.SessionStore;
      const pairing = yield* PairingGrantStore.PairingGrantStore;
      const value = new TextEncoder().encode("x");

      yield* secrets.set("cloud-relay-url", value);
      yield* secrets.set("cloud-link-ed25519-private-key", value);
      yield* secrets.set("guest-share-signing-key", value);
      yield* secrets.set("cloud-mint-nonce-abc", value);
      yield* secrets.set("cloud-health-jti-def", value);
      yield* secrets.set("dpop-proof-jti-keep", value);
      yield* secrets.set("cloud-something-new", value);
      const cloudflared = path.join(config.baseDir, "tools", "cloudflared");
      yield* fs.makeDirectory(cloudflared, { recursive: true });
      yield* fs.writeFileString(path.join(cloudflared, "cloudflared"), "binary");
      const otherTool = path.join(config.baseDir, "tools", "other");
      yield* fs.makeDirectory(otherTool, { recursive: true });

      const connectSession = yield* sessions.issue({ subject: "cloud-connect" });
      const browserSession = yield* sessions.issue({ subject: "browser" });
      const connectLink = yield* pairing.issueOneTimeToken({ subject: "cloud-connect" });
      const pairingLink = yield* pairing.issueOneTimeToken();

      const teardown = yield* ConnectTeardown.ConnectTeardown;
      const snapshot = Effect.gen(function* () {
        const secretFiles = (yield* fs.readDirectory(config.secretsDir)).toSorted();
        return {
          secretFiles,
          cloudflared: yield* fs.exists(cloudflared),
          otherTool: yield* fs.exists(otherTool),
          sessions: (yield* sessions.listActive()).map((session) => session.sessionId).toSorted(),
          links: (yield* pairing.listActive()).map((link) => link.id).toSorted(),
        };
      });

      yield* teardown.run();
      const after = yield* snapshot;
      expect(after.secretFiles).not.toContain("cloud-relay-url.bin");
      expect(after.secretFiles).not.toContain("cloud-link-ed25519-private-key.bin");
      expect(after.secretFiles).not.toContain("guest-share-signing-key.bin");
      expect(after.secretFiles).not.toContain("cloud-mint-nonce-abc.bin");
      expect(after.secretFiles).not.toContain("cloud-health-jti-def.bin");
      expect(after.secretFiles).toContain("dpop-proof-jti-keep.bin");
      expect(after.secretFiles).toContain("cloud-something-new.bin");
      expect(after.cloudflared).toBe(false);
      expect(after.otherTool).toBe(true);
      expect(after.sessions).toContain(browserSession.sessionId);
      expect(after.sessions).not.toContain(connectSession.sessionId);
      expect(after.links).toEqual([pairingLink.id]);
      expect(after.links).not.toContain(connectLink.id);
      expect(Option.isSome(yield* secrets.get("dpop-proof-jti-keep"))).toBe(true);

      yield* teardown.run();
      expect(yield* snapshot).toEqual(after);
    }).pipe(Effect.provide(layerTest)),
  );
});
