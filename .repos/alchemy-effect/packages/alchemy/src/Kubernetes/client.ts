import { Credentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import { AwsClient } from "aws4fetch";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as https from "node:https";
import {
  buildKubernetesObjectPath,
  chunkByApplyRank,
  kubernetesObjectKey,
  sortRefsForDelete,
  toKubernetesObjectRef,
  type KubernetesObjectDefinition,
  type KubernetesObjectRef,
} from "./types.ts";

export class KubernetesApiError extends Data.TaggedError("KubernetesApiError")<{
  method: string;
  path: string;
  statusCode: number;
  body: string;
}> {}

export interface KubernetesClusterConnection {
  clusterName: string;
  endpoint: string;
  certificateAuthorityData: string;
}

const fieldManager = "alchemy";

const createBearerToken = Effect.fn(function* (clusterName: string) {
  const credentials = yield* yield* Credentials;
  const region = yield* Region;

  const client = new AwsClient({
    accessKeyId: Redacted.value(credentials.accessKeyId),
    secretAccessKey: Redacted.value(credentials.secretAccessKey),
    sessionToken: credentials.sessionToken
      ? Redacted.value(credentials.sessionToken)
      : undefined,
    service: "sts",
    region,
  });

  const presigned = yield* Effect.tryPromise(() =>
    client.sign(
      new Request(
        `https://sts.${region}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15&X-Amz-Expires=60`,
        {
          headers: {
            "x-k8s-aws-id": clusterName,
          },
        },
      ),
      {
        aws: {
          signQuery: true,
          allHeaders: true,
        },
      },
    ),
  );

  return `k8s-aws-v1.${Buffer.from(presigned.url).toString("base64url")}`;
});

const requestJson = Effect.fn(function* ({
  connection,
  method,
  path,
  body,
}: {
  connection: KubernetesClusterConnection;
  method: string;
  path: string;
  body?: Record<string, unknown>;
}) {
  const token = yield* createBearerToken(connection.clusterName);
  const url = new URL(path, connection.endpoint);
  const payload = body ? JSON.stringify(body) : undefined;

  return yield* Effect.tryPromise({
    try: () =>
      new Promise<unknown>((resolve, reject) => {
        const request = https.request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || 443,
            path: `${url.pathname}${url.search}`,
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              ...(payload
                ? {
                    "Content-Type": "application/apply-patch+yaml",
                    "Content-Length": Buffer.byteLength(payload),
                  }
                : {}),
            },
            ca: Buffer.from(
              connection.certificateAuthorityData,
              "base64",
            ).toString("utf8"),
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            response.on("end", () => {
              const responseBody = Buffer.concat(chunks).toString("utf8");
              const statusCode = response.statusCode ?? 500;

              if (statusCode < 200 || statusCode >= 300) {
                reject(
                  new KubernetesApiError({
                    method,
                    path,
                    statusCode,
                    body: responseBody,
                  }),
                );
                return;
              }

              if (!responseBody.trim()) {
                resolve(undefined);
                return;
              }

              try {
                resolve(JSON.parse(responseBody));
              } catch {
                resolve(responseBody);
              }
            });
          },
        );

        request.on("error", reject);
        if (payload) {
          request.write(payload);
        }
        request.end();
      }),
    catch: (error) =>
      error instanceof KubernetesApiError
        ? error
        : new Error(
            `Failed Kubernetes ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`,
          ),
  });
});

export const readObject = Effect.fn(function* ({
  connection,
  object,
}: {
  connection: KubernetesClusterConnection;
  object: KubernetesObjectRef;
}) {
  return yield* requestJson({
    connection,
    method: "GET",
    path: buildKubernetesObjectPath(object),
  });
});

export const applyObject = Effect.fn(function* ({
  connection,
  object,
}: {
  connection: KubernetesClusterConnection;
  object: KubernetesObjectDefinition;
}) {
  const path = `${buildKubernetesObjectPath(toKubernetesObjectRef(object))}?fieldManager=${fieldManager}&force=true`;

  return yield* requestJson({
    connection,
    method: "PATCH",
    path,
    body: object,
  });
});

export const deleteObject = Effect.fn(function* ({
  connection,
  object,
}: {
  connection: KubernetesClusterConnection;
  object: KubernetesObjectRef;
}) {
  yield* requestJson({
    connection,
    method: "DELETE",
    path: buildKubernetesObjectPath(object),
  }).pipe(
    Effect.catchIf(
      (error): error is KubernetesApiError =>
        error instanceof KubernetesApiError,
      (error) => (error.statusCode === 404 ? Effect.void : Effect.fail(error)),
    ),
  );
});

export const reconcileObjects = Effect.fn(function* ({
  connection,
  previousObjects,
  desiredObjects,
}: {
  connection: KubernetesClusterConnection;
  previousObjects: ReadonlyArray<KubernetesObjectRef>;
  desiredObjects: ReadonlyArray<KubernetesObjectDefinition>;
}) {
  const desiredRefs = desiredObjects.map(toKubernetesObjectRef);
  const desiredKeys = new Set(desiredRefs.map(kubernetesObjectKey));

  const removedObjects = previousObjects.filter(
    (object) => !desiredKeys.has(kubernetesObjectKey(object)),
  );

  for (const object of sortRefsForDelete(removedObjects)) {
    yield* deleteObject({
      connection,
      object,
    });
  }

  for (const chunk of chunkByApplyRank(desiredObjects)) {
    yield* Effect.forEach(
      chunk,
      (object) =>
        applyObject({
          connection,
          object,
        }),
      {
        concurrency: "unbounded",
      },
    );
  }

  return desiredRefs;
});

export const deleteObjects = Effect.fn(function* ({
  connection,
  objects,
}: {
  connection: KubernetesClusterConnection;
  objects: ReadonlyArray<KubernetesObjectRef>;
}) {
  for (const object of sortRefsForDelete(objects)) {
    yield* deleteObject({
      connection,
      object,
    });
  }
});

export const createClient = (connection: KubernetesClusterConnection) => ({
  readObject: (object: KubernetesObjectRef) =>
    readObject({
      connection,
      object,
    }),
  applyObject: (object: KubernetesObjectDefinition) =>
    applyObject({
      connection,
      object,
    }),
  deleteObject: (object: KubernetesObjectRef) =>
    deleteObject({
      connection,
      object,
    }),
  reconcileObjects: ({
    previousObjects,
    desiredObjects,
  }: {
    previousObjects: ReadonlyArray<KubernetesObjectRef>;
    desiredObjects: ReadonlyArray<KubernetesObjectDefinition>;
  }) =>
    reconcileObjects({
      connection,
      previousObjects,
      desiredObjects,
    }),
  deleteObjects: (objects: ReadonlyArray<KubernetesObjectRef>) =>
    deleteObjects({
      connection,
      objects,
    }),
});
