import * as ACME from "@/ACME";
import * as Test from "@/Test/Alchemy";
import * as acme from "@distilled.cloud/acme/acme";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: ACME.providers() });
const ca = ACME.LetsEncryptStaging;

const lookup = (privateKey: Redacted.Redacted<string>) =>
  acme
    .newAccount({ onlyReturnExisting: true })
    .pipe(
      Effect.provide(ACME.accountLayer({ ca, accountKey: privateKey })),
      Effect.result,
    );

test.provider(
  "creates an account, keeps its key, synchronizes contacts and deactivates",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (contact?: string[]) =>
        ACME.Account("Account", {
          ca,
          contact,
          termsOfServiceAgreed: true,
        });
      const first = yield* stack.deploy(program(["mailto:ops@alchemy.run"]));
      expect(first.directoryUrl).toBe(ca.directoryUrl);
      expect(first.accountUrl).toContain(
        "acme-staging-v02.api.letsencrypt.org",
      );
      expect(first.status).toBe("valid");
      expect(first.keyAlgorithm).toBe("ES256");
      expect(Redacted.isRedacted(first.privateKey)).toBe(true);
      const found = yield* lookup(first.privateKey);
      expect(Result.isSuccess(found)).toBe(true);
      if (Result.isSuccess(found))
        expect(found.success.location).toBe(first.accountUrl);

      const again = yield* stack.deploy(program(["mailto:ops@alchemy.run"]));
      expect(again.accountUrl).toBe(first.accountUrl);
      expect(
        Redacted.value(again.privateKey) === Redacted.value(first.privateKey),
      ).toBe(true);

      const updated = yield* stack.deploy(program());
      expect(updated.accountUrl).toBe(first.accountUrl);
      const observed = yield* lookup(first.privateKey);
      expect(Result.isSuccess(observed)).toBe(true);
      if (Result.isSuccess(observed))
        expect(observed.success.contact ?? []).toEqual([]);
      yield* stack.destroy();
      const gone = yield* lookup(first.privateKey);
      expect(Result.isFailure(gone)).toBe(true);
      if (Result.isFailure(gone))
        expect(["AcmeUnauthorized", "AcmeAccountDoesNotExist"]).toContain(
          gone.failure._tag,
        );
    }),
  { tags: ["provider:acme", "provider:acme:account", "live"], timeout: 90_000 },
);

test.provider(
  "changing the key algorithm replaces and deactivates the old account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const first = yield* stack.deploy(
        ACME.Account("Account", { ca, termsOfServiceAgreed: true }),
      );
      const replaced = yield* stack.deploy(
        ACME.Account("Account", {
          ca,
          termsOfServiceAgreed: true,
          keyAlgorithm: "RS256",
        }),
      );
      expect(replaced.keyAlgorithm).toBe("RS256");
      expect(replaced.accountUrl).not.toBe(first.accountUrl);
      expect(
        (JSON.parse(Redacted.value(replaced.privateKey)) as { kty: string })
          .kty,
      ).toBe("RSA");
      expect(Result.isFailure(yield* lookup(first.privateKey))).toBe(true);
      yield* stack.destroy();
      expect(Result.isFailure(yield* lookup(replaced.privateKey))).toBe(true);
    }),
  { tags: ["provider:acme", "provider:acme:account", "live"], timeout: 90_000 },
);
