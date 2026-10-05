import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Region from "@distilled.cloud/gcp/Region";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import { fromCredentials, GcpEnvironment } from "@/GCP/Environment";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({
  providers: GCP.providers().pipe(Layer.provideMerge(GCP.Region("us-east4"))),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test(
  "regional endpoint routing",
  Effect.sync(() => {
    const base = "https://secretmanager.googleapis.com/";
    expect(
      Region.endpointFor(
        base,
        "v1/projects/p/locations/us-east1/secrets/s",
        "required",
      ),
    ).toEqual("https://secretmanager.us-east1.rep.googleapis.com/");
    expect(
      Region.endpointFor(base, "v1/projects/p/secrets/s", "required"),
    ).toEqual(base);
    expect(
      Region.endpointFor(
        "https://run.googleapis.com/",
        "v2/projects/p/locations/us-east1/services/s",
        "required",
      ),
    ).toEqual("https://run.googleapis.com/");
    expect(
      Region.endpointFor(
        "https://run.googleapis.com/",
        "v2/projects/p/locations/us-east1/services/s",
        "prefer",
      ),
    ).toEqual("https://run.us-east1.rep.googleapis.com/");
  }),
  { tags: ["unit", "provider:gcp", "provider:gcp:region", "local"] },
);

const credentialWithRegion = (region: string | undefined) =>
  Layer.succeed(
    Credentials,
    Effect.succeed({
      accessToken: Redacted.make("token"),
      project: "p",
      region,
    }),
  );

const resolvedRegion = (layer: Layer.Layer<GcpEnvironment>) =>
  GcpEnvironment.use((env) => Effect.map(env, (e) => e.region)).pipe(
    Effect.provide(layer),
  );

test(
  "the credential's region is the default; GCP.Region overrides it",
  Effect.gen(function* () {
    expect(
      yield* resolvedRegion(
        fromCredentials().pipe(
          Layer.provide(credentialWithRegion("asia-east1")),
        ),
      ),
    ).toEqual("asia-east1");
    expect(
      yield* resolvedRegion(
        fromCredentials().pipe(Layer.provide(credentialWithRegion(undefined))),
      ),
    ).toEqual("us-central1");
    expect(
      yield* resolvedRegion(
        fromCredentials().pipe(
          Layer.provide(credentialWithRegion("asia-east1")),
          Layer.provide(GCP.Region("europe-west1")),
        ),
      ),
    ).toEqual("europe-west1");
  }),
  { tags: ["unit", "provider:gcp", "provider:gcp:region", "local"] },
);

test.provider(
  "a stack-level GCP.Region sets the default region; regional secrets reach their endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          // No `location`: placed in the scope's default region.
          const queue = yield* GCP.CloudTasks.Queue("RegionQueue", {});
          // A regional secret, also in the default region.
          const secret = yield* GCP.SecretManager.LocationsSecret(
            "RegionalSecret",
            {},
          );
          return { queue: queue.name, secret: secret.name };
        }),
      );

      expect(out.queue).toContain("/locations/us-east4/");
      expect(out.secret).toContain("/locations/us-east4/");

      // Out-of-band read with plain fetch: distilled routes the regional
      // secret to secretmanager.us-east4.rep.googleapis.com.
      const live = yield* secretmanager.getProjectsLocationsSecrets({
        name: out.secret,
      });
      expect(live.name).toEqual(out.secret);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:gcp",
      "provider:gcp:cloudtasks",
      "provider:gcp:secretmanager",
      "live",
    ],
    timeout: 240_000,
  },
);

const withoutOverride = Test.make({ providers: GCP.providers() });

withoutOverride.test.provider(
  "without GCP.Region, the credential's region is the default",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* GCP.CloudTasks.Queue(
            "CredentialsRegionQueue",
            {},
          );
          return { queue: queue.name, region: yield* GCP.currentRegion };
        }),
      );
      // The testing credential sets no region, so the default applies.
      expect(out.region).toEqual("us-central1");
      expect(out.queue).toContain("/locations/us-central1/");
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudtasks", "live"],
    timeout: 120_000,
  },
);
