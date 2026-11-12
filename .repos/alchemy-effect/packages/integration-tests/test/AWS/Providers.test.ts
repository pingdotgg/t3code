import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as s3 from "@distilled.cloud/aws/s3";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { AuthProvidersLive } from "alchemy/Auth/AuthProvider";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { State, type ResourceState } from "alchemy/State";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { v4 as uuidv4 } from "uuid";

it.live(
  "building the AWS provider layers rejects an unknown explicit profile",
  () =>
    Effect.gen(function* () {
      // AWSEnvironment is constructed lazily so `alchemy dev` can build
      // provider layers without credentials. The unknown-profile rejection
      // surfaces on first use, not at `Layer.build`.
      const result = yield* Effect.result(
        Effect.sandbox(AWSEnvironment.current.pipe(Effect.provide(AWS.providers()))),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("does not exist");
        expect(String(result.failure)).toContain("alchemy profile create");
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          AuthProvidersLive,
          Layer.sync(ArtifactStore, createArtifactStore),
          Layer.succeed(Stage, "test"),
          Layer.succeed(Stack, {
            name: "test",
            stage: "test",
            resources: {},
            bindings: {},
            actions: {},
          }),
          Layer.succeed(AlchemyContext, { dev: false, adopt: false, dotAlchemy: ".alchemy" }),
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ ALCHEMY_PROFILE: `non-existent-${uuidv4()}` }),
          ),
          ProfileStoreLive,
        ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
      ),
    ),
  { tags: ["unit", "provider:aws", "local"] },
);

// The profile's own environment, moved to another region. Providing it to
// `AWS.providers()` / `AWS.state()` from outside must win over the built-in
// profile default — the region makes it observable.
const PROVIDED_REGION = "us-east-2";
const providedEnvironment = Layer.effect(
  AWSEnvironment,
  Effect.gen(function* () {
    const profileEnvironment = yield* AWSEnvironment;
    return Effect.map(profileEnvironment, (environment) => ({
      ...environment,
      region: PROVIDED_REGION,
    }));
  }),
).pipe(Layer.provide(AWS.providers()));

const provided = Test.make({
  providers: AWS.providers().pipe(Layer.provide(providedEnvironment)),
});

provided.test.provider(
  "a provided AWSEnvironment drives providers() and state()",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Resources deploy with the provided environment.
      const bucket = yield* stack.deploy(
        AWS.S3.Bucket("ProvidedEnvironmentBucket", { forceDestroy: true }),
      );
      expect(bucket.region).toBe(PROVIDED_REGION);
      const location = yield* s3.getBucketLocation({ Bucket: bucket.bucketName });
      expect(location.LocationConstraint).toBe(PROVIDED_REGION);

      // The state store uses the same provided environment: a round-trip
      // against the bucket in that region.
      const state = yield* (yield* State).pipe(
        Effect.provide(
          AWS.state({ bucketName: bucket.bucketName, prefix: "provided-environment" }).pipe(
            Layer.provide(providedEnvironment),
          ),
        ),
      );
      const row = {
        resourceType: "test:resource",
        namespace: undefined,
        fqn: "Provided",
        logicalId: "Provided",
        instanceId: "instance-provided",
        providerVersion: 1,
        status: "created",
        downstream: [],
        bindings: [],
        props: {},
        attr: { value: "provided" },
      } as unknown as ResourceState;
      const key = { stack: "ProvidedEnvironmentStack", stage: "provided" };
      yield* state.set({ ...key, fqn: row.fqn, value: row });
      expect(yield* state.get({ ...key, fqn: row.fqn })).toEqual(row);
      yield* state.deleteStack(key);

      yield* stack.destroy();
    }),
  {
    tags: ["provider:aws", "provider:aws:s3", "provider:aws:statestore", "live"],
    timeout: 180_000,
  },
);
