// Probe live availability of BDA library + blueprint-optimization APIs.
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import { Region } from "@distilled.cloud/aws/Region";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const runtime = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  Credentials.fromChain(),
  Layer.succeed(Region, "us-west-2"),
);

const show = (label: string, r: Result.Result<unknown, unknown>) => {
  if (Result.isSuccess(r)) {
    console.log(label, "OK", JSON.stringify(r.success).slice(0, 300));
  } else {
    const e = r.failure as { _tag?: string; message?: string };
    console.log(label, "ERR", e?._tag, e?.message?.slice(0, 200));
  }
};

const main = Effect.gen(function* () {
  show(
    "listDataAutomationLibraries",
    yield* Effect.result(bda.listDataAutomationLibraries({ maxResults: 3 })),
  );
  show(
    "getBlueprintOptimizationStatus(bogus)",
    yield* Effect.result(
      bda.getBlueprintOptimizationStatus({
        invocationArn:
          "arn:aws:bedrock:us-west-2:000000000000:data-automation-invocation/00000000-0000-0000-0000-000000000000",
      }),
    ),
  );
});

await Effect.runPromise(main.pipe(Effect.provide(runtime)));
