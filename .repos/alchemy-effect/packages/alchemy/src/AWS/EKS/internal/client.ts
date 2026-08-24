/**
 * Internal EKS Kubernetes API client: SigV4-token auth against the cluster
 * endpoint, server-side apply, and kind discovery for arbitrary (CRD)
 * manifests. Powers `AWS.EKS.Manifest`, `AWS.EKS.Deployment`, `AWS.EKS.Job`,
 * and the `AWS.EKS.Cluster` kubernetes-object binding channel. Not exported
 * from the EKS index.
 */
import { Credentials } from "@distilled.cloud/aws/Credentials";
import { AwsClient } from "aws4fetch";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as https from "node:https";
import { AWSEnvironment } from "../../Environment.ts";
import {
  buildKubernetesObjectPathWithSpec,
  chunkByApplyRank,
  DEFAULT_APPLY_RANK,
  kubernetesObjectKey,
  lookupKubernetesKindSpec,
  sortRefsForDelete,
  toKubernetesObjectRef,
  type KubernetesObjectDefinition,
  type KubernetesObjectKindSpec,
  type KubernetesObjectRef,
} from "./objects.ts";

export class KubernetesApiError extends Data.TaggedError("KubernetesApiError")<{
  method: string;
  path: string;
  statusCode: number;
  body: string;
}> {
  override get message(): string {
    return `${this.method} ${this.path} responded ${this.statusCode}: ${
      this.body.length > 0 ? this.body.slice(0, 1000) : "(empty body)"
    }`;
  }
}

export interface KubernetesClusterConnection {
  clusterName: string;
  endpoint: string;
  certificateAuthorityData: string;
}

const fieldManager = "alchemy";

const createBearerToken = Effect.fn(function* (clusterName: string) {
  const credentials = yield* yield* Credentials;
  const { region } = yield* AWSEnvironment.current;

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
  }).pipe(
    // Transport-level failures (ECONNREFUSED/ECONNRESET/ETIMEDOUT/DNS)
    // are transient — a fresh EKS endpoint's NLB can refuse connections
    // for a short window after the cluster reports ACTIVE. Every request
    // here is idempotent (GET / SSA PATCH / DELETE), so retry them; HTTP
    // errors (KubernetesApiError) are handled by the callers.
    Effect.retry({
      while: (e): boolean => !(e instanceof KubernetesApiError),
      schedule: Schedule.max([
        Schedule.spaced("5 seconds"),
        Schedule.recurs(8),
      ]),
    }),
  );
});

// ─────────────────────────────────────────────────────── kind discovery ──

interface ApiResourceList {
  resources?: {
    name?: string;
    kind?: string;
    namespaced?: boolean;
  }[];
}

// One resolution per (endpoint, apiVersion, kind) per process. Plain cached
// values (no finalizers), so module scope is safe.
const discoveredKinds = new Map<string, KubernetesObjectKindSpec>();

/**
 * Resolve the REST mapping (plural + scope) for an arbitrary kind: static
 * table fast path, then the Kubernetes discovery API (`/apis/{g}/{v}` or
 * `/api/v1`). This is what lets `AWS.EKS.Manifest` apply any CRD.
 */
export const resolveKindSpec = Effect.fn(function* ({
  connection,
  input,
}: {
  connection: KubernetesClusterConnection;
  input: Pick<KubernetesObjectRef, "apiVersion" | "kind">;
}) {
  const staticSpec = lookupKubernetesKindSpec(input);
  if (staticSpec) return staticSpec;

  const cacheKey = `${connection.endpoint}|${input.apiVersion}|${input.kind}`;
  const cached = discoveredKinds.get(cacheKey);
  if (cached) return cached;

  const discoveryPath = input.apiVersion.includes("/")
    ? `/apis/${input.apiVersion}`
    : `/api/${input.apiVersion}`;

  const listed = (yield* requestJson({
    connection,
    method: "GET",
    path: discoveryPath,
  })) as ApiResourceList;

  const resource = listed.resources?.find(
    (candidate) =>
      candidate.kind === input.kind &&
      typeof candidate.name === "string" &&
      !candidate.name.includes("/"),
  );

  if (!resource?.name) {
    return yield* Effect.fail(
      new KubernetesApiError({
        method: "GET",
        path: discoveryPath,
        statusCode: 404,
        body: `Kind '${input.kind}' not found in API group '${input.apiVersion}'`,
      }),
    );
  }

  const spec: KubernetesObjectKindSpec = {
    plural: resource.name,
    scope: resource.namespaced ? "Namespaced" : "Cluster",
    applyRank: DEFAULT_APPLY_RANK,
  };
  discoveredKinds.set(cacheKey, spec);
  return spec;
});

const buildPath = Effect.fn(function* ({
  connection,
  object,
}: {
  connection: KubernetesClusterConnection;
  object: KubernetesObjectRef;
}) {
  const spec = yield* resolveKindSpec({ connection, input: object });
  return yield* Effect.try({
    try: () => buildKubernetesObjectPathWithSpec(object, spec),
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });
});

// ─────────────────────────────────────────────────────────── object ops ──

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
    path: yield* buildPath({ connection, object }),
  });
});

export const applyObject = Effect.fn(function* ({
  connection,
  object,
}: {
  connection: KubernetesClusterConnection;
  object: KubernetesObjectDefinition;
}) {
  const basePath = yield* buildPath({
    connection,
    object: toKubernetesObjectRef(object),
  });
  const path = `${basePath}?fieldManager=${fieldManager}&force=true`;

  return yield* requestJson({
    connection,
    method: "PATCH",
    path,
    body: object,
  }).pipe(
    // A freshly ACTIVE cluster's API server briefly 5xxes while warming
    // up, and the creator's bootstrap access entry propagates
    // asynchronously (401/403 in the first minute) — retry transient
    // failures for ~1 min.
    Effect.retry({
      while: (e): boolean =>
        e instanceof KubernetesApiError &&
        (e.statusCode >= 500 ||
          e.statusCode === 429 ||
          e.statusCode === 401 ||
          e.statusCode === 403),
      schedule: Schedule.max([
        Schedule.spaced("6 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );
});

export const deleteObject = Effect.fn(function* ({
  connection,
  object,
}: {
  connection: KubernetesClusterConnection;
  object: KubernetesObjectRef;
}) {
  yield* buildPath({ connection, object }).pipe(
    Effect.flatMap((path) =>
      requestJson({
        connection,
        method: "DELETE",
        path,
      }),
    ),
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
