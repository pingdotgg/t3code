import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as S3 from "alchemy/AWS/S3";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import ApiFunction from "./src/ApiFunction.ts";

export default Alchemy.Stack(
  "aws-dev",
  {
    providers: AWS.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* ApiFunction;

    // Deploy-time Action data plane: seed an object into a bucket during
    // apply and read it back, reporting which AWS account served the calls.
    // Under `alchemy dev` the calls MUST land on the floci emulator — the
    // dummy account id (000000000000) in the stack outputs is the proof.
    // CLI-path counterpart of the harness regression in
    // packages/alchemy/test/AWS/S3/Bucket.data-plane.test.ts.
    const bucket = yield* S3.Bucket("SeedBucket", { forceDestroy: true });
    const SeedObject = Alchemy.Action(
      "SeedObject",
      Effect.gen(function* () {
        const putObject = yield* S3.PutObject(bucket);
        const getObject = yield* S3.GetObject(bucket);
        return Effect.fn(function* (input: { key: string; body: string }) {
          const environment = yield* AWS.AWSEnvironment.current;
          yield* putObject({ Key: input.key, Body: input.body });
          const object = yield* getObject({ Key: input.key });
          const text = yield* (
            object.Body?.pipe(Stream.decodeText, Stream.mkString) ??
              Effect.succeed("")
          );
          return { accountId: environment.accountId, text };
        });
      }).pipe(Effect.provide([S3.PutObjectHttp, S3.GetObjectHttp])),
    );
    const seeded = yield* SeedObject({
      key: "seed.txt",
      body: "seed-object-body-v1",
    });

    return {
      api: api.functionUrl,
      seedAccount: seeded.accountId,
      seedText: seeded.text,
    };
  }),
);
