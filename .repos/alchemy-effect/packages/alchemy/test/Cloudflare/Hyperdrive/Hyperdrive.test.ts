import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Neon from "@/Neon";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as hyperdrive from "@distilled.cloud/cloudflare/hyperdrive";
import { assert, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({
  providers: Layer.merge(Cloudflare.providers(), Neon.providers()),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
test.provider("create and delete hyperdrive with default props", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const { db, hd } = yield* stack.deploy(
      Effect.gen(function* () {
        const db = yield* Neon.Project("DefaultProject");
        const hd = yield* Cloudflare.Hyperdrive.Connection(
          "DefaultHyperdrive",
          {
            origin: db.origin,
          },
        );
        return { db, hd };
      }),
    );

    expect(hd.hyperdriveId).toBeDefined();
    expect(hd.name).toBeDefined();

    const actual = yield* hyperdrive.getConfig({
      accountId,
      hyperdriveId: hd.hyperdriveId,
    });
    expect(actual.id).toEqual(hd.hyperdriveId);
    assert("host" in actual.origin, "db.origin must have a host");
    expect(actual.origin.host).toEqual(db.origin.host);

    yield* stack.destroy();

    yield* waitForConfigToBeDeleted(hd.hyperdriveId, accountId);
  }).pipe(logLevel),
);

test.provider("create, update, delete hyperdrive", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const hd = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Neon.Project("CRUDProject");
        return yield* Cloudflare.Hyperdrive.Connection("CRUDHyperdrive", {
          origin: project.origin,
          caching: { disabled: false, maxAge: 60 },
        });
      }),
    );

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Neon.Project("CRUDProject");
        return yield* Cloudflare.Hyperdrive.Connection("CRUDHyperdrive", {
          origin: project.origin,
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

test.provider("list enumerates the deployed hyperdrive", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const hd = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Neon.Project("ListProject");
        return yield* Cloudflare.Hyperdrive.Connection("ListHyperdrive", {
          origin: project.origin,
        });
      }),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.Hyperdrive.Connection,
    );
    const all = yield* provider.list();

    expect(all.some((x) => x.hyperdriveId === hd.hyperdriveId)).toBe(true);

    yield* stack.destroy();
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
