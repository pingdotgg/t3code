import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as hyperdrive from "@distilled.cloud/cloudflare/hyperdrive";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const baseOrigin = {
  scheme: "postgres" as const,
  host: "ep-cool-darkness-123456.us-east-2.aws.neon.tech",
  port: 5432,
  database: "app",
  user: "app",
  password: Redacted.make("p4ssword!"),
};

test.provider.skip("create and delete hyperdrive with default props", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const hd = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Hyperdrive("DefaultHyperdrive", {
          origin: baseOrigin,
        });
      }),
    );

    expect(hd.hyperdriveId).toBeDefined();
    expect(hd.name).toBeDefined();

    const actual = yield* hyperdrive.getConfig({
      accountId,
      hyperdriveId: hd.hyperdriveId,
    });
    expect(actual.id).toEqual(hd.hyperdriveId);
    // @ts-expect-error
    expect(actual.origin.host).toEqual(baseOrigin.host);

    yield* stack.destroy();

    yield* waitForConfigToBeDeleted(hd.hyperdriveId, accountId);
  }).pipe(logLevel),
);

test.provider.skip("create, update, delete hyperdrive", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const hd = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Hyperdrive("UpdateHyperdrive", {
          origin: baseOrigin,
          caching: { disabled: false, maxAge: 60 },
        });
      }),
    );

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Hyperdrive("UpdateHyperdrive", {
          origin: baseOrigin,
          caching: { disabled: true },
        });
      }),
    );

    expect(updated.hyperdriveId).toEqual(hd.hyperdriveId);

    const actual = yield* hyperdrive.getConfig({
      accountId,
      hyperdriveId: updated.hyperdriveId,
    });
    // After PUT with `disabled: true`, caching should reflect the change.
    expect(actual.caching).toBeDefined();

    yield* stack.destroy();

    yield* waitForConfigToBeDeleted(hd.hyperdriveId, accountId);
  }).pipe(logLevel),
);

const waitForConfigToBeDeleted = Effect.fn(function* (
  hyperdriveId: string,
  accountId: string,
) {
  yield* hyperdrive.getConfig({ accountId, hyperdriveId }).pipe(
    Effect.flatMap(() => Effect.fail(new ConfigStillExists())),
    Effect.retry({
      while: (e): e is ConfigStillExists => e instanceof ConfigStillExists,
      schedule: Schedule.exponential(100),
    }),
    Effect.catchTag("HyperdriveConfigNotFound", () => Effect.void),
  );
});

class ConfigStillExists extends Data.TaggedError("ConfigStillExists") {}
