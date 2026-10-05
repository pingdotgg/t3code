import { createHash } from "node:crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { defaultProviderMode } from "../ProviderMode.ts";
import * as Binding from "../Binding.ts";
import * as Output from "../Output.ts";
import {
  CurrentRuntimeContext,
  type RuntimeContext,
} from "../RuntimeContext.ts";
import { bindBackendEnvironment } from "./BackendConnection.ts";
import { scopeIdentity, usesInjectedCredentials } from "./CredentialScope.ts";
import type { Bucket } from "./Bucket.ts";
import { Credential, validateCredential } from "./Credential.ts";
import { FunctionEnvironment } from "./FunctionEnvironment.ts";
import {
  makeStorageClient,
  type StorageClient,
  type StorageConfig,
} from "./Storage.ts";

export interface StorageBindingOptions {
  /** Explicit sharing; validated against the requested scope and branch lineage. */
  credential?: Credential;
}
export class StorageBindingError extends Data.TaggedError(
  "StorageBindingError",
)<{ message: string }> {}

export type RuntimeStorageMethods<K extends keyof StorageClient> = {
  [P in K]: (
    ...args: Parameters<StorageClient[P]>
  ) => Effect.Effect<
    Effect.Success<ReturnType<StorageClient[P]>>,
    Effect.Error<ReturnType<StorageClient[P]>> | StorageBindingError,
    RuntimeContext
  >;
};

/** Internal host wiring shared by read/write and object-bound capabilities. */
export const makeStorageBinding = (scope: "storage:read" | "storage:write") =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const runtime = yield* CurrentRuntimeContext;
    if (!runtime)
      return yield* Effect.die(
        new StorageBindingError({
          message: "Storage bindings require a Platform host",
        }),
      );
    const environment = yield* Effect.serviceOption(FunctionEnvironment);
    const createCredential = yield* Credential;
    return Effect.fn(function* (
      bucket: Bucket,
      options: StorageBindingOptions = {},
    ) {
      const host = yield* Binding.Host;
      if (!host)
        return yield* Effect.die(
          new StorageBindingError({
            message: "Storage binding requires a runtime host",
          }),
        );
      const digest = yield* Effect.sync(() =>
        createHash("sha256")
          .update(
            `${host.FQN}:${scopeIdentity(bucket.Props) ?? bucket.FQN}:${scope}:${options.credential?.FQN ?? "managed"}`,
          )
          .digest("hex")
          .slice(0, 24),
      );
      const prefix = `NEON_STORAGE_${digest.toUpperCase()}`;
      const bucketKey = `${prefix}_${yield* Effect.sync(() => createHash("sha256").update(bucket.FQN).digest("hex").slice(0, 12).toUpperCase())}_BUCKET`;
      const keys = {
        injected: `${prefix}_INJECTED`,
        endpoint: `${prefix}_ENDPOINT`,
        region: `${prefix}_REGION`,
        accessKeyId: `${prefix}_ACCESS_KEY_ID`,
        secretAccessKey: `${prefix}_SECRET_ACCESS_KEY`,
      };
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const mode = host.Mode ?? (yield* defaultProviderMode);
        const injected =
          !options.credential &&
          usesInjectedCredentials(host, bucket.Props, mode);
        const env: Record<
          string,
          Output.Output<string | Redacted.Redacted<string>>
        > = {
          [bucketKey]: bucket.bucketName,
          [keys.injected]: Output.literal(injected ? "yes" : "no"),
          [keys.endpoint]: bucket.endpoint,
          [keys.region]: bucket.region,
        };
        if (!injected) {
          const credential =
            options.credential ??
            (yield* createCredential(`Storage${digest}`, {
              ...(bucket.Props.branch !== undefined
                ? { branch: bucket.Props.branch }
                : { project: bucket.Props.project }),
              scopes:
                scope === "storage:write"
                  ? ["storage:read", "storage:write"]
                  : [scope],
            }));
          const validated = Output.all(
            Output.of(credential),
            Output.of(bucket),
          ).pipe(
            Output.mapEffect(
              Effect.fn(function* ([credential, target]) {
                yield* validateCredential(credential, target, scope).pipe(
                  Effect.orDie,
                );
                if (scope === "storage:write")
                  yield* validateCredential(
                    credential,
                    target,
                    "storage:read",
                  ).pipe(Effect.orDie);
                return credential;
              }),
            ),
          );
          env[keys.accessKeyId] = validated.tokenId;
          env[keys.secretAccessKey] = validated.s3SecretAccessKey;
        }
        yield* bindBackendEnvironment(`Storage${digest}:${bucket.FQN}`, env);
      }
      const required = (key: string) =>
        runtime.get<string | Redacted.Redacted<string>>(key).pipe(
          Effect.flatMap((value) =>
            value === undefined
              ? Effect.fail(
                  new StorageBindingError({
                    message: `Missing storage binding variable ${key}`,
                  }),
                )
              : Effect.succeed(
                  Redacted.isRedacted(value) ? Redacted.value(value) : value,
                ),
          ),
        );
      const config = Effect.gen(function* () {
        if ((yield* required(keys.injected)) === "yes") {
          const env = Option.getOrUndefined(environment);
          if (
            !env?.AWS_ACCESS_KEY_ID ||
            !env.AWS_SECRET_ACCESS_KEY ||
            !env.AWS_ENDPOINT_URL_S3 ||
            !env.AWS_REGION
          ) {
            return yield* new StorageBindingError({
              message: "Neon Function did not inject complete S3 credentials",
            });
          }
          return {
            endpoint: env.AWS_ENDPOINT_URL_S3,
            region: env.AWS_REGION,
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: Redacted.make(env.AWS_SECRET_ACCESS_KEY),
          } satisfies StorageConfig;
        }
        return {
          endpoint: yield* required(keys.endpoint),
          region: yield* required(keys.region),
          accessKeyId: yield* required(keys.accessKeyId),
          secretAccessKey: Redacted.make(yield* required(keys.secretAccessKey)),
        } satisfies StorageConfig;
      });
      const client = Effect.gen(function* () {
        return yield* makeStorageClient(
          yield* config,
          yield* required(bucketKey),
        );
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, http)));
      return {
        get: (key: string) => client.pipe(Effect.flatMap((c) => c.get(key))),
        head: (key: string) => client.pipe(Effect.flatMap((c) => c.head(key))),
        list: (options?: Parameters<StorageClient["list"]>[0]) =>
          client.pipe(Effect.flatMap((c) => c.list(options))),
        presign: (...args: Parameters<StorageClient["presign"]>) =>
          client.pipe(Effect.flatMap((c) => c.presign(...args))),
        put: (...args: Parameters<StorageClient["put"]>) =>
          client.pipe(Effect.flatMap((c) => c.put(...args))),
        delete: (key: string) =>
          client.pipe(Effect.flatMap((c) => c.delete(key))),
        deleteMany: (keys: string[]) =>
          client.pipe(Effect.flatMap((c) => c.deleteMany(keys))),
        createMultipartUpload: (
          ...args: Parameters<StorageClient["createMultipartUpload"]>
        ) =>
          client.pipe(Effect.flatMap((c) => c.createMultipartUpload(...args))),
        uploadPart: (...args: Parameters<StorageClient["uploadPart"]>) =>
          client.pipe(Effect.flatMap((c) => c.uploadPart(...args))),
        completeMultipartUpload: (
          ...args: Parameters<StorageClient["completeMultipartUpload"]>
        ) =>
          client.pipe(
            Effect.flatMap((c) => c.completeMultipartUpload(...args)),
          ),
        abortMultipartUpload: (
          ...args: Parameters<StorageClient["abortMultipartUpload"]>
        ) =>
          client.pipe(Effect.flatMap((c) => c.abortMultipartUpload(...args))),
        listMultipartUploads: (
          ...args: Parameters<StorageClient["listMultipartUploads"]>
        ) =>
          client.pipe(Effect.flatMap((c) => c.listMultipartUploads(...args))),
        listParts: (...args: Parameters<StorageClient["listParts"]>) =>
          client.pipe(Effect.flatMap((c) => c.listParts(...args))),
      };
    });
  });

export const storageHttpLayer = FetchHttpClient.layer;
