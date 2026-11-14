import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import {
  DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS,
  currentDesktopBootstrapToken,
} from "@t3tools/shared/desktopBootstrapToken";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";

const layerServerConfig = (
  overrides?: Partial<
    Pick<ServerConfig.ServerConfig["Service"], "desktopBootstrapToken" | "desktopBootstrapSecret">
  >,
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

const layerPairingGrantStore = (
  overrides?: Partial<
    Pick<ServerConfig.ServerConfig["Service"], "desktopBootstrapToken" | "desktopBootstrapSecret">
  >,
) =>
  PairingGrantStore.layer.pipe(
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(layerServerConfig(overrides)),
  );

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("PairingGrantStore.layer", (it) => {
  it.effect.each(["aaaaaaaaaaaa", "aaaa-aaaa-aaaa", "aaaa aaaa aaaa", "\taaaa - AAAA - aaaa\n"])(
    "accepts formatted one-time tokens exactly once: %j",
    (credential) =>
      Effect.gen(function* () {
        const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
        const issued = yield* bootstrapCredentials.issueOneTimeToken({ label: "Julius iPhone" });
        for (const invalid of [
          `${issued.credential}A`,
          issued.credential.slice(1),
          issued.credential.replace("A", "I"),
          "AAAA/AAAA/AAAA",
          "AAAA–AAAA–AAAA",
        ]) {
          const rejected = yield* Effect.flip(bootstrapCredentials.consume(invalid));
          expect(rejected._tag).toBe("UnknownBootstrapCredentialError");
        }
        const first = yield* bootstrapCredentials.consume(credential);
        const second = yield* Effect.flip(bootstrapCredentials.consume(issued.credential));

        expect(first.method).toBe("one-time-token");
        expect(first.scopes).toEqual(AuthStandardClientScopes);
        expect(first.subject).toBe("one-time-token");
        expect(first.label).toBe("Julius iPhone");
        expect(issued.label).toBe("Julius iPhone");
        expect(second._tag).toBe("UnknownBootstrapCredentialError");
        expect(second.message).toContain("Unknown bootstrap credential");
      }).pipe(
        Effect.provide(layerPairingGrantStore()),
        Effect.provideService(
          SecureRandom.SecureRandom,
          SecureRandom.make((size) => new Uint8Array(size).fill(8)),
        ),
      ),
  );

  it.effect("atomically consumes a one-time token when multiple requests race", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const token = yield* bootstrapCredentials.issueOneTimeToken();
      const results = yield* Effect.all(
        Array.from({ length: 8 }, (_, index) =>
          Effect.result(
            bootstrapCredentials.consume(
              index % 2 === 0
                ? token.credential
                : `${token.credential.slice(0, 4)}-${token.credential.slice(4, 8)}-${token.credential.slice(8)}`,
              {
                requestedScopes: ["orchestration:read"],
              },
            ),
          ),
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
    }).pipe(Effect.provide(layerPairingGrantStore())),
  );

  it.effect.each(["raw", "formatted"])("requires the bound proof key for %s codes", (format) =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const token = yield* bootstrapCredentials.issueOneTimeToken({
        proofKeyThumbprint: "client-proof-key-thumbprint",
        scopes: ["orchestration:read"],
      });
      const credential =
        format === "formatted"
          ? `${token.credential.slice(0, 4)}-${token.credential.slice(4, 8)}-${token.credential.slice(8)}`
          : token.credential;

      const missing = yield* Effect.flip(bootstrapCredentials.consume(credential));
      const wrong = yield* Effect.flip(
        bootstrapCredentials.consume(credential, {
          proofKeyThumbprint: "other-proof-key-thumbprint",
          requestedScopes: ["access:write"],
        }),
      );
      const forbiddenScope = yield* Effect.flip(
        bootstrapCredentials.consume(credential, {
          proofKeyThumbprint: "client-proof-key-thumbprint",
          requestedScopes: ["access:write"],
        }),
      );
      const consumed = yield* bootstrapCredentials.consume(credential, {
        proofKeyThumbprint: "client-proof-key-thumbprint",
        requestedScopes: ["orchestration:read"],
      });

      expect(missing.message).toContain("proof key mismatch");
      expect(wrong.message).toContain("proof key mismatch");
      expect(forbiddenScope._tag).toBe("BootstrapCredentialScopeNotGrantedError");
      expect(consumed.proofKeyThumbprint).toBe("client-proof-key-thumbprint");
    }).pipe(Effect.provide(layerPairingGrantStore())),
  );

  it.effect("matches a seeded desktop bootstrap credential exactly", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const exact = yield* bootstrapCredentials.consume("abcdefghjkmn");
      const otherCase = yield* Effect.flip(bootstrapCredentials.consume("ABCDEFGHJKMN"));
      const formatted = yield* Effect.flip(bootstrapCredentials.consume("abcd-efgh-jkmn"));

      expect(exact.method).toBe("desktop-bootstrap");
      expect(otherCase._tag).toBe("UnknownBootstrapCredentialError");
      expect(formatted._tag).toBe("UnknownBootstrapCredentialError");
    }).pipe(
      Effect.provide(
        layerPairingGrantStore({
          desktopBootstrapToken: "abcdefghjkmn",
        }),
      ),
    ),
  );

  it.effect("reports seeded desktop bootstrap credentials as expired after their ttl", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;

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
          layerPairingGrantStore({
            desktopBootstrapToken: "desktop-bootstrap-token",
          }),
          TestClock.layer(),
        ),
      ),
    ),
  );

  it.effect("accepts rotating desktop bootstrap tokens derived from the desktop secret", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const window = DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS;

      yield* TestClock.adjust(Duration.days(5));
      const now = 5 * 24 * 60 * 60 * 1000;
      const current = yield* bootstrapCredentials.consume(
        yield* currentDesktopBootstrapToken("desktop-secret", now).pipe(
          Effect.provide(NodeCrypto.layerMac),
        ),
      );
      expect(current.method).toBe("desktop-bootstrap");

      const staleToken = yield* currentDesktopBootstrapToken(
        "desktop-secret",
        now - 2 * window,
      ).pipe(Effect.provide(NodeCrypto.layerMac));
      const stale = yield* Effect.flip(bootstrapCredentials.consume(staleToken));
      expect(stale._tag).toBe("UnknownBootstrapCredentialError");

      const launch = yield* Effect.flip(bootstrapCredentials.consume("desktop-bootstrap-token"));
      expect(launch._tag).toBe("UnknownBootstrapCredentialError");
    }).pipe(
      Effect.provide(
        Layer.merge(
          layerPairingGrantStore({
            desktopBootstrapToken: "desktop-bootstrap-token",
            desktopBootstrapSecret: "desktop-secret",
          }),
          TestClock.layer(),
        ),
      ),
    ),
  );

  it.effect("keeps credentials out of pairing lists and change events", () =>
    Effect.gen(function* () {
      const grants = yield* PairingGrantStore.PairingGrantStore;
      const changes = yield* Queue.unbounded<PairingGrantStore.BootstrapCredentialChange>();
      yield* grants.streamChanges.pipe(
        Stream.runForEach((change) => Queue.offer(changes, change)),
        Effect.forkScoped({ startImmediately: true }),
      );
      // An app approval code sends no update, issued or spent; the next belongs to a plain code.
      const approval = yield* grants.issueOneTimeToken({ mcpApproval: "auto" });
      yield* grants.consume(approval.credential, { mcpApproval: "auto" });
      for (const input of [{}, { label: "Synthetic phone" }]) {
        const issued = yield* grants.issueOneTimeToken(input);
        const change = yield* Queue.take(changes);
        expect(change?.type).toBe("pairingLinkUpserted");
        if (change?.type !== "pairingLinkUpserted")
          throw new Error("Expected a pairing link update");
        expect(change.pairingLink.id).toBe(issued.id);
        expect(change.pairingLink).not.toHaveProperty("credential");
        const listed = (yield* grants.listActive()).find((link) => link.id === issued.id);
        expect(listed).toEqual(change.pairingLink);
        const consumed = yield* grants.consume(issued.credential);
        expect(consumed.scopes).toEqual(change.pairingLink.scopes);
        expect(yield* Queue.take(changes)).toEqual({ type: "pairingLinkRemoved", id: issued.id });
      }
    }).pipe(Effect.scoped, Effect.provide(layerPairingGrantStore())),
  );
});
