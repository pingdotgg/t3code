import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create, update duration, and delete service token", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const token = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Access.ServiceToken("BasicToken", {});
      }),
    );

    expect(token.serviceTokenId).toBeDefined();
    expect(token.accountId).toEqual(accountId);
    expect(token.clientId).toBeDefined();
    // The client secret is only revealed on create — it must be captured.
    expect(token.clientSecret).toBeDefined();
    expect(Redacted.value(token.clientSecret!).length).toBeGreaterThan(0);

    const actual = yield* zeroTrust.getAccessServiceTokenForAccount({
      accountId,
      serviceTokenId: token.serviceTokenId,
    });
    expect(actual.id).toEqual(token.serviceTokenId);
    expect(actual.clientId).toEqual(token.clientId);
    expect(actual.name).toEqual(token.name);

    // Update — change the validity duration in place (same id) and keep
    // the previously captured secret.
    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Access.ServiceToken("BasicToken", {
          duration: "17520h",
        });
      }),
    );
    expect(updated.serviceTokenId).toEqual(token.serviceTokenId);
    expect(updated.duration).toEqual("17520h");
    expect(updated.clientSecret).toBeDefined();
    expect(Redacted.value(updated.clientSecret!)).toEqual(
      Redacted.value(token.clientSecret!),
    );

    const afterUpdate = yield* zeroTrust.getAccessServiceTokenForAccount({
      accountId,
      serviceTokenId: token.serviceTokenId,
    });
    expect(afterUpdate.duration).toEqual("17520h");

    yield* stack.destroy();

    const afterDestroy = yield* zeroTrust
      .getAccessServiceTokenForAccount({
        accountId,
        serviceTokenId: token.serviceTokenId,
      })
      .pipe(
        Effect.catchTag("AccessServiceTokenNotFound", () =>
          Effect.succeed(undefined),
        ),
      );
    expect(afterDestroy?.id ?? undefined).toBeUndefined();
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed service token", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const token = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Access.ServiceToken("ListToken", {});
      }),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.Access.ServiceToken,
    );
    const all = yield* provider.list();

    expect(all.some((t) => t.serviceTokenId === token.serviceTokenId)).toBe(
      true,
    );
    // Enumeration never exposes the one-time secret — it matches read.
    const found = all.find((t) => t.serviceTokenId === token.serviceTokenId);
    expect(found?.clientId).toEqual(token.clientId);
    expect(found?.clientSecret).toBeUndefined();

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("incrementing clientSecretVersion rotates the secret", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const token = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Access.ServiceToken("RotateToken", {});
      }),
    );
    expect(token.clientSecret).toBeDefined();
    expect(token.clientSecretVersion).toEqual(1);

    const rotated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Access.ServiceToken("RotateToken", {
          clientSecretVersion: 2,
        });
      }),
    );
    expect(rotated.serviceTokenId).toEqual(token.serviceTokenId);
    expect(rotated.clientId).toEqual(token.clientId);
    expect(rotated.clientSecretVersion).toEqual(2);
    expect(rotated.clientSecret).toBeDefined();
    expect(Redacted.value(rotated.clientSecret!)).not.toEqual(
      Redacted.value(token.clientSecret!),
    );

    // Re-deploying the same version must NOT rotate again.
    const stable = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Access.ServiceToken("RotateToken", {
          clientSecretVersion: 2,
        });
      }),
    );
    expect(stable.serviceTokenId).toEqual(token.serviceTokenId);
    expect(Redacted.value(stable.clientSecret!)).toEqual(
      Redacted.value(rotated.clientSecret!),
    );

    const actual = yield* zeroTrust.getAccessServiceTokenForAccount({
      accountId,
      serviceTokenId: token.serviceTokenId,
    });
    expect(actual.id).toEqual(token.serviceTokenId);

    yield* stack.destroy();
  }).pipe(logLevel),
);
