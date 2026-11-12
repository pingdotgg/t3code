import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";

/** Secrets T3 Connect and guest links stored. Exact names only; nothing else is matched. */
const CONNECT_SECRET_NAMES = [
  "cloud-mint-ed25519-public-key",
  "cloud-endpoint-runtime-config",
  "cloud-endpoint-confirmed-origin",
  "cloud-endpoint-http2-fallback",
  "cloud-linked-user-id",
  "cloud-relay-url",
  "cloud-relay-issuer",
  "cloud-relay-environment-credential",
  "cloud-publish-agent-activity",
  "cloud-hold-webhooks-while-offline",
  "cloud-link-revoked",
  "cloud-link-ed25519-key-pair",
  "cloud-link-ed25519-private-key",
  "cloud-link-ed25519-public-key",
  "cloud-cli-desired-link",
  "cloud-cli-oauth-token",
  "guest-share-signing-key",
] as const;

/** One-use markers T3 Connect proofs wrote into the secrets directory as `<prefix><id>.bin`. */
const CONNECT_REPLAY_MARKER_PREFIXES = [
  "cloud-mint-nonce-",
  "cloud-mint-jti-",
  "cloud-health-nonce-",
  "cloud-health-jti-",
] as const;

/** Sessions and pairing links T3 Connect minted on this machine. */
const CONNECT_SESSION_SUBJECT = "cloud-connect";

export class ConnectTeardown extends Context.Service<
  ConnectTeardown,
  {
    /** Idempotent: a second run finds nothing left to remove. Never fails; problems are logged. */
    readonly run: () => Effect.Effect<void>;
  }
>()("t3/environment/ConnectTeardown") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const sessions = yield* SessionStore.SessionStore;
  const pairingLinks = yield* PairingGrantStore.PairingGrantStore;

  const removeSecrets = Effect.forEach(CONNECT_SECRET_NAMES, (name) => secrets.remove(name), {
    discard: true,
  });

  const removeReplayMarkers = fileSystem.readDirectory(config.secretsDir).pipe(
    Effect.map((names) =>
      names.filter(
        (name) =>
          name.endsWith(".bin") &&
          CONNECT_REPLAY_MARKER_PREFIXES.some((prefix) => name.startsWith(prefix)),
      ),
    ),
    Effect.flatMap((names) =>
      Effect.forEach(
        names,
        (name) => fileSystem.remove(path.join(config.secretsDir, name), { force: true }),
        { discard: true },
      ),
    ),
  );

  const removeCloudflared = fileSystem.remove(path.join(config.baseDir, "tools", "cloudflared"), {
    recursive: true,
    force: true,
  });

  const revokeConnectClients = Effect.gen(function* () {
    const connectSessions = (yield* sessions.listActive()).filter(
      (session) => session.subject === CONNECT_SESSION_SUBJECT,
    );
    yield* Effect.forEach(connectSessions, (session) => sessions.revoke(session.sessionId), {
      discard: true,
    });
    const connectLinks = (yield* pairingLinks.listActive()).filter(
      (link) => link.subject === CONNECT_SESSION_SUBJECT,
    );
    yield* Effect.forEach(connectLinks, (link) => pairingLinks.revoke(link.id), {
      discard: true,
    });
  });

  const step = <A, E>(name: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to remove T3 Connect leftovers", { step: name, cause }),
      ),
      Effect.asVoid,
    );

  return ConnectTeardown.of({
    run: Effect.fn("ConnectTeardown.run")(function* () {
      yield* step("secrets", removeSecrets);
      yield* step("replay-markers", removeReplayMarkers);
      yield* step("cloudflared", removeCloudflared);
      yield* step("sessions", revokeConnectClients);
    }),
  });
});

export const layer = Layer.effect(ConnectTeardown, make);
