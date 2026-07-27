import * as AWS from "@/AWS";
import { AccessPolicy } from "@/AWS/OpenSearchServerless";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import AossIndexFunctionLive, {
  AossIndexFunction,
  COLLECTION_NAME,
} from "./index-bindings-handler";

const { test } = Test.make({ providers: AWS.providers() });

const ACC_POLICY = "alchemy-aossb-acc";

// A route answering 5xx is retried: the fixture's data access policy and IAM
// grants propagate asynchronously after deploy (typically well under a
// minute), and the handler's Effect.orDie surfaces AccessDenied as a 500.
const drive = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.succeed(response)
        : Effect.fail(new Error(`route not ready: ${response.status}`)),
    ),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(24),
      ]),
    }),
  );

// Collections have a real-money OCU floor and take ~1-5 min to provision, so
// the index data-plane bindings (aoss:APIAccessAll) are gated behind
// AWS_TEST_SLOW=1, destroy IMMEDIATELY, and verify the collection is gone.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "index bindings roundtrip against a live collection (AWS_TEST_SLOW=1)",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight. Set
      // AOSS_KEEP_COLLECTION=1 to skip it and converge onto the surviving
      // resources instead (collections take minutes to provision, so reusing
      // one keeps the re-run inside the runner's wall clock).
      if (!process.env.AOSS_KEEP_COLLECTION) {
        yield* stack.destroy();
      }

      const { fn } = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* AossIndexFunction;
          // The data access policy granting the function's role index
          // permissions — the control-plane index APIs enforce it in
          // addition to the IAM aoss:APIAccessAll grant.
          yield* AccessPolicy("Acc", {
            policyName: ACC_POLICY,
            policy: Output.interpolate`[{"Rules":[{"ResourceType":"index","Resource":["index/${COLLECTION_NAME}/*"],"Permission":["aoss:*"]},{"ResourceType":"collection","Resource":["collection/${COLLECTION_NAME}"],"Permission":["aoss:*"]}],"Principal":["${fn.roleArn}"]}]`,
          });
          return { fn };
        }).pipe(Effect.provide(AossIndexFunctionLive)),
      );

      expect(fn.functionUrl).toBeTruthy();
      const baseUrl = fn.functionUrl!.replace(/\/+$/, "");

      // GetCollection — the bound collection is ACTIVE with an endpoint.
      const collection = (yield* drive(
        HttpClientRequest.get(`${baseUrl}/collection`),
      ).pipe(Effect.flatMap((r) => r.json))) as any;
      expect(collection.status).toBe("ACTIVE");
      expect(collection.endpoint).toContain("aoss.amazonaws.com");

      // Create → read → update → delete an index at runtime.
      const roundtrip = (yield* drive(
        HttpClientRequest.post(`${baseUrl}/index/roundtrip`),
      ).pipe(Effect.flatMap((r) => r.json))) as any;
      expect(roundtrip.created).toBe(true);
      expect(roundtrip.hadSchema).toBe(true);
      expect(roundtrip.deleted).toBe(true);

      // Destroy immediately — collections meter OCUs while they exist — and
      // verify deletion out-of-band.
      const collectionId = collection.id as string;
      yield* stack.destroy();
      yield* assertCollectionGone(collectionId);
    }),
  { timeout: 900_000 },
);

// Deletion is verified as INITIATED (status `DELETING`) or fully gone — full
// disappearance takes another ~1-2 min server-side.
const assertCollectionGone = (id: string) =>
  Effect.gen(function* () {
    const response = yield* aoss.batchGetCollection({ ids: [id] });
    const detail = response.collectionDetails?.[0];
    const status = detail?.status ?? "gone";
    if (status !== "gone" && status !== "DELETING") {
      return yield* Effect.fail(
        new Error(`Collection '${id}' still exists (status: ${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(24),
      ]),
    }),
  );
