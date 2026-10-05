import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

/** Object seeded into the source bucket; the transfer copies it. */
export const SEED_KEY = "transfer/hello.txt";
export const SEED_TEXT = "hello from the transfer source";

export const Source = Effect.gen(function* () {
  const source = yield* GCP.Storage.Bucket("Src", {
    location: "US-CENTRAL1",
    forceDestroy: true,
  });
  yield* GCP.Storage.Object("SrcSeed", {
    bucketName: source.bucketName,
    key: SEED_KEY,
    content: SEED_TEXT,
    contentType: "text/plain",
  });
  return source;
});

export const Sink = GCP.Storage.Bucket("Dst", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

/** A manual (unscheduled) job copying the source bucket into the sink. */
export const Copy = Effect.gen(function* () {
  const source = yield* Source;
  const sink = yield* Sink;
  return yield* GCP.StorageTransfer.TransferJob("Copy", {
    description: "binding probe",
    status: "ENABLED",
    transferSpec: {
      gcsDataSource: { bucketName: source.bucketName },
      gcsDataSink: { bucketName: sink.bucketName },
    },
  });
});

/**
 * Effect-native Cloud Run service exercising every Storage Transfer
 * binding as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class StorageTransferBindingsHost extends GCP.Function<StorageTransferBindingsHost>()(
  "StorageTransferBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getAccount = yield* GCP.StorageTransfer.GetGoogleServiceAccount(Copy);
    const runJob = yield* GCP.StorageTransfer.RunTransferJob(Copy);

    return {
      fetch: serveProbes({
        getGoogleServiceAccount: getAccount().pipe(
          Effect.map((account) => ({ accountEmail: account.accountEmail })),
        ),
        runTransferJob: runJob().pipe(
          Effect.map((operation) => ({ name: operation.name })),
        ),
      }),
    };
  }).pipe(
    Effect.provide(GCP.StorageTransfer.GetGoogleServiceAccountHttp),
    Effect.provide(GCP.StorageTransfer.RunTransferJobHttp),
  ),
) {}
