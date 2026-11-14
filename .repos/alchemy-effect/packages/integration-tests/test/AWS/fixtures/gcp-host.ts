import * as AWS from "@alchemy.run/aws";
import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../GCP/bindingHost.ts";

/** Queue the Cloud Run host sends to. */
export const Jobs = AWS.SQS.Queue("FederatedJobs");

/**
 * Effect-native Cloud Run service binding an AWS queue. It runs as a Google
 * service account, so it reaches SQS by assuming a Role with its Google ID
 * token, not with an access key. Deployed from {@link ../AWSBindings.test.ts}.
 */
export default class FederatedHost extends GCP.Function<FederatedHost>()(
  "FederatedHost",
  { main: import.meta.url, location: "us-central1", invokerIamDisabled: true },
  Effect.gen(function* () {
    const send = yield* AWS.SQS.SendMessage(Jobs);
    return {
      fetch: serveProbes({
        send: send({ MessageBody: "hello from cloud run" }),
      }),
    };
  }).pipe(Effect.provide(AWS.SQS.SendMessageHttp)),
) {}
