import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deterministic key material (this is test-only, not a real secret).
const SECRET_A =
  "kyTZf6QHTPVdpDjLWWbYO7DI3Z6f3wWvECDCtMHEOSomCnq0db4DBzowg4QH51jJZUw5n4nGYNGmkJhCfn+9Ag==";
const SECRET_B =
  "8nNZTjsM1Yu0aFYNYTcMM2KFCDc2cMKQz3mNkLV0XzUgDgQ4Mc7XhhSh0RUFhd6OYzz6Vl5hUTUVUYz1JBdt0g==";

// Ride out fresh-token 403 blips on out-of-band calls.
const retryForbidden = <A, E extends { _tag: string }, R>(
  eff: Effect.Effect<A, E, R>,
) =>
  eff.pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const getTsig = (accountId: string, tsigId: string) =>
  retryForbidden(dns.getZoneTransferTsig({ accountId, tsigId }));

// A deleted TSIG surfaces as the typed `TsigNotFound` (HTTP 404).
const expectGone = (accountId: string, tsigId: string) =>
  getTsig(accountId, tsigId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "TsigNotDeleted" } as const)),
    Effect.catchTag("TsigNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "TsigNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create, rotate the secret in place, and delete a TSIG",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Cloudflare.DNS.ZoneTransferTsig("TestTsig", {
          name: "alchemy-dnszt-tsig-test.",
          algo: "hmac-sha512.",
          secret: Redacted.make(SECRET_A),
        }),
      );
      expect(created.tsigId).toBeDefined();
      expect(created.accountId).toEqual(accountId);
      expect(created.name).toEqual("alchemy-dnszt-tsig-test.");
      expect(created.algo).toEqual("hmac-sha512.");
      // The secret is never persisted in attributes.
      expect("secret" in created).toBe(false);

      // Out-of-band verify via the SDK.
      const live = yield* getTsig(accountId, created.tsigId);
      expect(live.name).toEqual("alchemy-dnszt-tsig-test.");
      expect(live.secret).toEqual(SECRET_A);

      // Rotate the secret in place — same physical TSIG.
      const rotated = yield* stack.deploy(
        Cloudflare.DNS.ZoneTransferTsig("TestTsig", {
          name: "alchemy-dnszt-tsig-test.",
          algo: "hmac-sha512.",
          secret: Redacted.make(SECRET_B),
        }),
      );
      expect(rotated.tsigId).toEqual(created.tsigId);

      const liveRotated = yield* getTsig(accountId, created.tsigId);
      expect(liveRotated.secret).toEqual(SECRET_B);

      yield* stack.destroy();
      yield* expectGone(accountId, created.tsigId);

      // Re-running destroy is idempotent.
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (account-scoped collection): deploy a real TSIG,
// resolve the provider from context via the typed `findProvider`, call
// `list()`, and assert the deployed TSIG appears in the exhaustively-paginated
// result.
test.provider(
  "list enumerates the deployed TSIG",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Cloudflare.DNS.ZoneTransferTsig("ListTsig", {
          name: "alchemy-dnszt-tsig-list.",
          algo: "hmac-sha512.",
          secret: Redacted.make(SECRET_A),
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.DNS.ZoneTransferTsig,
      );
      const all = yield* provider.list();

      expect(all.some((t) => t.tsigId === deployed.tsigId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
