import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthAdministrativeScopes, AuthStandardClientScopes } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as AuthPairingLinks from "../persistence/AuthPairingLinks.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";

const makeServerConfigLayer = (
  overrides?: Partial<Pick<ServerConfig.ServerConfig["Service"], "desktopBootstrapToken">>,
) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-bootstrap-test-" })),
  );

const makePairingGrantStoreLayer = (
  overrides?: Partial<Pick<ServerConfig.ServerConfig["Service"], "desktopBootstrapToken">>,
) =>
  PairingGrantStore.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(makeServerConfigLayer(overrides)),
  );

const makePairingGrantStoreTestLayer = (
  overrides: Partial<AuthPairingLinks.AuthPairingLinkRepository["Service"]>,
) =>
  Layer.effect(PairingGrantStore.PairingGrantStore, PairingGrantStore.make).pipe(
    Layer.provide(
      Layer.succeed(
        AuthPairingLinks.AuthPairingLinkRepository,
        AuthPairingLinks.AuthPairingLinkRepository.of({
          create: () => Effect.void,
          consumeAvailable: () => Effect.succeed(Option.none()),
          listActive: () => Effect.succeed([]),
          revoke: () => Effect.succeed(false),
          getByCredential: () => Effect.succeed(Option.none()),
          ...overrides,
        }),
      ),
    ),
    Layer.provide(makeServerConfigLayer()),
  );

it.layer(NodeServices.layer)("PairingGrantStore.layer", (it) => {
  it.effect("issues pairing tokens in a short manual-entry format", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const issued = yield* bootstrapCredentials.issueOneTimeToken();

      expect(issued.credential).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/);
    }).pipe(Effect.provide(makePairingGrantStoreLayer())),
  );

  it.effect("issues one-time bootstrap tokens that can only be consumed once", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const issued = yield* bootstrapCredentials.issueOneTimeToken({ label: "Julius iPhone" });
      const first = yield* bootstrapCredentials.consume(issued.credential);
      const second = yield* Effect.flip(bootstrapCredentials.consume(issued.credential));

      expect(first.method).toBe("one-time-token");
      expect(first.scopes).toEqual([...AuthStandardClientScopes]);
      expect(first.subject).toBe("one-time-token");
      expect(first.label).toBe("Julius iPhone");
      expect(issued.label).toBe("Julius iPhone");
      expect(second._tag).toBe("UnknownBootstrapCredentialError");
      expect(second.message).toContain("Unknown bootstrap credential");
    }).pipe(Effect.provide(makePairingGrantStoreLayer())),
  );

  it.effect("atomically consumes a one-time token when multiple requests race", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const token = yield* bootstrapCredentials.issueOneTimeToken();
      const results = yield* Effect.all(
        Array.from({ length: 8 }, () =>
          Effect.result(bootstrapCredentials.consume(token.credential)),
        ),
        {
          concurrency: "unbounded",
        },
      );

      const successes = results.filter((result) => result._tag === "Success");
      const failures = results.filter((result) => result._tag === "Failure");

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(7);
      for (const failure of failures) {
        expect(failure.failure._tag).toBe("UnknownBootstrapCredentialError");
        expect(failure.failure.message).toContain("Unknown bootstrap credential");
      }
    }).pipe(Effect.provide(makePairingGrantStoreLayer())),
  );

  it.effect("requires the bound proof key thumbprint when present", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const token = yield* bootstrapCredentials.issueOneTimeToken({
        proofKeyThumbprint: "client-proof-key-thumbprint",
      });

      const missing = yield* Effect.flip(bootstrapCredentials.consume(token.credential));
      const wrong = yield* Effect.flip(
        bootstrapCredentials.consume(token.credential, {
          proofKeyThumbprint: "other-proof-key-thumbprint",
        }),
      );
      const consumed = yield* bootstrapCredentials.consume(token.credential, {
        proofKeyThumbprint: "client-proof-key-thumbprint",
      });

      expect(missing.message).toContain("proof key mismatch");
      expect(wrong.message).toContain("proof key mismatch");
      expect(consumed.proofKeyThumbprint).toBe("client-proof-key-thumbprint");
    }).pipe(Effect.provide(makePairingGrantStoreLayer())),
  );

  it.effect("seeds the desktop bootstrap credential as a reusable grant", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const first = yield* bootstrapCredentials.consume("desktop-bootstrap-token");
      const second = yield* bootstrapCredentials.consume("desktop-bootstrap-token");
      const third = yield* bootstrapCredentials.consume("desktop-bootstrap-token");

      expect(first.method).toBe("desktop-bootstrap");
      expect(first.scopes).toEqual([...AuthAdministrativeScopes]);
      expect(first.subject).toBe("desktop-bootstrap");
      expect(second.method).toBe("desktop-bootstrap");
      expect(third.method).toBe("desktop-bootstrap");
    }).pipe(
      Effect.provide(
        makePairingGrantStoreLayer({
          desktopBootstrapToken: "desktop-bootstrap-token",
        }),
      ),
    ),
  );

  it.effect("reports seeded desktop bootstrap credentials as expired after their ttl", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;

      // The desktop-bootstrap grant lives for 24h. Within that window
      // it stays reusable.
      yield* TestClock.adjust(Duration.hours(12));
      const stillValid = yield* bootstrapCredentials.consume("desktop-bootstrap-token");
      expect(stillValid.method).toBe("desktop-bootstrap");

      yield* TestClock.adjust(Duration.hours(13));
      const expired = yield* Effect.flip(bootstrapCredentials.consume("desktop-bootstrap-token"));

      expect(expired._tag).toBe("ExpiredBootstrapCredentialError");
      expect(expired.message).toContain("Bootstrap credential expired");
    }).pipe(
      Effect.provide(
        Layer.merge(
          makePairingGrantStoreLayer({
            desktopBootstrapToken: "desktop-bootstrap-token",
          }),
          TestClock.layer(),
        ),
      ),
    ),
  );

  it.effect("lists and revokes active pairing links", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const first = yield* bootstrapCredentials.issueOneTimeToken();
      const second = yield* bootstrapCredentials.issueOneTimeToken({
        scopes: ["orchestration:read", "access:write"],
      });

      const activeBeforeRevoke = yield* bootstrapCredentials.listActive();
      expect(activeBeforeRevoke.map((entry) => entry.id)).toContain(first.id);
      expect(activeBeforeRevoke.map((entry) => entry.id)).toContain(second.id);

      const revoked = yield* bootstrapCredentials.revoke(first.id);
      const activeAfterRevoke = yield* bootstrapCredentials.listActive();
      const revokedConsume = yield* Effect.flip(bootstrapCredentials.consume(first.credential));

      expect(revoked).toBe(true);
      expect(activeAfterRevoke.map((entry) => entry.id)).not.toContain(first.id);
      expect(activeAfterRevoke.map((entry) => entry.id)).toContain(second.id);
      expect(revokedConsume.message).toContain("no longer available");
      expect(revokedConsume._tag).toBe("UnavailableBootstrapCredentialError");
    }).pipe(Effect.provide(makePairingGrantStoreLayer())),
  );

  it.effect("identifies consume-available failures and preserves their cause", () => {
    const repositoryFailure = new PersistenceSqlError({
      operation: "consume-pairing-link",
      detail: "Database unavailable",
      cause: new Error("database unavailable"),
    });

    return Effect.gen(function* () {
      const pairingGrants = yield* PairingGrantStore.PairingGrantStore;
      const error = yield* Effect.flip(pairingGrants.consume("credential"));

      if (error._tag !== "BootstrapCredentialConsumeAvailableError") {
        return yield* Effect.die(error);
      }
      expect(error.cause).toBe(repositoryFailure);
    }).pipe(
      Effect.provide(
        makePairingGrantStoreTestLayer({
          consumeAvailable: () => Effect.fail(repositoryFailure),
        }),
      ),
    );
  });
});
