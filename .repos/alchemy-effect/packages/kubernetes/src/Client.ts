import * as https from "node:https";
import { isPlainObject, unwrapRedacted } from "alchemy/Util/data";
import { collectRedactedSecrets, redactJson } from "alchemy/Util/Redaction";
/**
 * Internal Kubernetes API client: transport-agnostic server-side apply and
 * kind discovery for arbitrary (CRD) manifests. Powers
 * `Kubernetes.Manifest`, `Kubernetes.Deployment`, `Kubernetes.Job`,
 * `Kubernetes.HelmChart`, and the `AWS.EKS.Cluster` kubernetes-object
 * binding channel. Not exported from the Kubernetes index.
 *
 * Authentication is delegated to the connection's {@link ClusterAdapter}:
 * every request mints headers through the resolved
 * {@link ClusterTransport}, so short-lived tokens (EKS SigV4 presigns,
 * exec-plugin credentials) stay fresh.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  ClusterNotFoundError,
  findClusterAdapter,
  type ClusterTransport,
} from "./ClusterAdapter.ts";
import type { Connection } from "./Connection.ts";
import { driftMask, hashDriftSelection } from "./internal/declared.ts";
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
} from "./Objects.ts";

export class KubernetesClientOperationFailed extends Data.TaggedError(
  "KubernetesClientOperationFailed",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

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

/** An object ref that cannot be mapped to a REST path (e.g. a namespaced kind without a namespace). */
export class KubernetesObjectPathError extends Data.TaggedError("KubernetesObjectPathError")<{
  message: string;
  cause?: unknown;
}> {}

const fieldManager = "alchemy";

/** Deadline for auth-header minting and for each HTTP attempt. */
const requestTimeout = "10 seconds";

/**
 * Resolve the {@link ClusterTransport} for a connection through its
 * registered adapter.
 */
export const connectCluster = (connection: Connection) =>
  findClusterAdapter(connection.auth.kind).pipe(
    Effect.flatMap((adapter) => adapter.connect(connection)),
  );

/** 404 from the apiserver, including a removed CRD's discovery 404. */
export class KubernetesNotFound extends Data.TaggedError("KubernetesNotFound")<{
  method: string;
  path: string;
  body: string;
}> {
  override get message(): string {
    return `${this.method} ${this.path} responded 404: ${
      this.body.length > 0 ? this.body.slice(0, 1000) : "(empty body)"
    }`;
  }
}

/**
 * The effect's result when the cluster exists. `ClusterNotFoundError`
 * becomes `undefined`; auth and HTTP failures stay failures.
 */
export const ifClusterExists = <A, E, R>(effect: Effect.Effect<A, ClusterNotFoundError | E, R>) =>
  effect.pipe(Effect.catchTag("Kubernetes.ClusterNotFoundError", () => Effect.undefined));

const requestJson = Effect.fn(function* ({
  transport,
  method,
  path,
  body,
  redactions = [],
}: {
  transport: ClusterTransport;
  method: string;
  path: string;
  body?: Record<string, unknown>;
  /** Secrets already plaintext in `body` (Helm renders them). */
  redactions?: readonly string[];
}) {
  // Outside the attempt retry: a hung token mint must not be retried as
  // if it were a refused connection.
  const headers = yield* transport.headers.pipe(Effect.timeout(requestTimeout));
  const url = new URL(path, transport.endpoint);
  // JSON.stringify(Redacted) emits the display placeholder. Unwrap only at
  // the wire so plans and state keep the wrapper.
  const prepared = yield* Effect.sync(() => {
    const payload = body === undefined ? undefined : JSON.stringify(unwrapRedacted(body));
    return {
      payload,
      contentLength: payload === undefined ? undefined : Buffer.byteLength(payload),
      ca:
        transport.certificateAuthorityData === undefined
          ? undefined
          : Buffer.from(transport.certificateAuthorityData, "base64").toString("utf8"),
      secrets: [...(body === undefined ? [] : collectRedactedSecrets(body)), ...redactions],
    };
  });

  const response = yield* Effect.callback<
    { readonly statusCode: number; readonly body: string },
    Error
  >((resume, signal) => {
    const request = https.request(
      {
        signal,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          ...headers,
          Accept: "application/json",
          ...(prepared.payload === undefined
            ? {}
            : {
                "Content-Type": "application/apply-patch+yaml",
                "Content-Length": prepared.contentLength,
              }),
        },
        ...(prepared.ca === undefined ? {} : { ca: prepared.ca }),
        ...(transport.clientCert
          ? {
              cert: transport.clientCert.certificate,
              key: transport.clientCert.key,
            }
          : {}),
        ...(transport.insecureSkipTlsVerify ? { rejectUnauthorized: false } : {}),
      },
      (incoming) => {
        const chunks: Uint8Array[] = [];
        incoming.on("data", (chunk: Uint8Array) => {
          chunks.push(chunk);
        });
        incoming.on("error", (error) => {
          resume(Effect.fail(error));
        });
        incoming.on("aborted", () => {
          resume(
            Effect.fail(
              new KubernetesClientOperationFailed({
                message: `Kubernetes ${method} ${path} response aborted`,
              }),
            ),
          );
        });
        incoming.on("end", () => {
          if (incoming.complete === false) {
            resume(
              Effect.fail(
                new KubernetesClientOperationFailed({
                  message: `Kubernetes ${method} ${path} response ended before completion`,
                }),
              ),
            );
            return;
          }
          const statusCode = incoming.statusCode ?? 500;
          resume(
            Effect.sync(() => ({
              statusCode,
              body: Buffer.concat(chunks).toString("utf8"),
            })),
          );
        });
      },
    );
    request.on("error", (error) => {
      resume(
        Effect.fail(
          error instanceof Error
            ? error
            : new KubernetesClientOperationFailed({ message: String(error) }),
        ),
      );
    });
    if (prepared.payload !== undefined) request.write(prepared.payload);
    request.end();
    // Bun's TLS client ignores AbortSignal. Destroying the socket releases it.
    // Effect.callback already drops a second resume, and this finalizer runs
    // on the same interrupt that aborts `signal`.
    return Effect.sync(() => {
      request.destroy();
      request.socket?.destroy();
    });
  }).pipe(
    Effect.timeout(requestTimeout),
    Effect.mapError(
      (error) =>
        new KubernetesClientOperationFailed({
          message: `Failed Kubernetes ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`,
        }),
    ),
    // Transport-level failures (ECONNREFUSED/ECONNRESET/ETIMEDOUT/DNS,
    // the per-attempt deadline) are transient — a fresh managed endpoint's
    // load balancer can refuse connections for a short window after the
    // cluster reports ready. Every request here is idempotent (GET / SSA
    // PATCH / DELETE), so retry them. HTTP status errors are classified
    // below and are not retried here.
    Effect.retry({
      schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(8)]),
    }),
  );

  if (response.statusCode < 200 || response.statusCode >= 300) {
    // Error bodies can echo the request. Scrub only failures —
    // a successful dry-run is the object we compare for drift.
    const responseBody = yield* Effect.sync(() => redactJson(response.body, prepared.secrets));
    if (response.statusCode === 404) {
      return yield* new KubernetesNotFound({ method, path, body: responseBody });
    }
    return yield* new KubernetesApiError({
      method,
      path,
      statusCode: response.statusCode,
      body: responseBody,
    });
  }

  if (!response.body.trim()) return undefined;
  return yield* Effect.sync(() => {
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      return response.body;
    }
  });
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
 * `/api/v1`). This is what lets `Kubernetes.Manifest` apply any CRD.
 */
export const resolveKindSpec = Effect.fn(function* ({
  transport,
  input,
}: {
  transport: ClusterTransport;
  input: Pick<KubernetesObjectRef, "apiVersion" | "kind">;
}) {
  const staticSpec = lookupKubernetesKindSpec(input);
  if (staticSpec) return staticSpec;

  const cacheKey = `${transport.endpoint}|${input.apiVersion}|${input.kind}`;
  const cached = discoveredKinds.get(cacheKey);
  if (cached) return cached;

  const discoveryPath = input.apiVersion.includes("/")
    ? `/apis/${input.apiVersion}`
    : `/api/${input.apiVersion}`;

  const listed = (yield* requestJson({
    transport,
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
    return yield* new KubernetesNotFound({
      method: "GET",
      path: discoveryPath,
      body: `Kind '${input.kind}' not found in API group '${input.apiVersion}'`,
    });
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
  transport,
  object,
}: {
  transport: ClusterTransport;
  object: KubernetesObjectRef;
}) {
  const spec = yield* resolveKindSpec({ transport, input: object });
  return yield* Effect.try({
    try: () => buildKubernetesObjectPathWithSpec(object, spec),
    catch: (error) =>
      new KubernetesObjectPathError({
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      }),
  });
});

// ─────────────────────────────────────────────────────────── object ops ──

export const readObject = Effect.fn(function* ({
  transport,
  object,
}: {
  transport: ClusterTransport;
  object: KubernetesObjectRef;
}) {
  return yield* requestJson({
    transport,
    method: "GET",
    path: yield* buildPath({ transport, object }),
  }).pipe(
    // Drift reads a whole Helm release at once. A 429 is the apiserver
    // asking for a pause, not a failed object.
    Effect.retry({
      while: (error) => error instanceof KubernetesApiError && error.statusCode === 429,
      schedule: Schedule.max([Schedule.spaced("1 second"), Schedule.recurs(4)]),
    }),
  );
});

export const applyObject = Effect.fn(function* ({
  transport,
  object,
  redactions,
}: {
  transport: ClusterTransport;
  object: KubernetesObjectDefinition;
  /** Plaintext secrets already rendered into `object` (Helm values). */
  redactions?: readonly string[];
}) {
  const basePath = yield* buildPath({
    transport,
    object: toKubernetesObjectRef(object),
  });
  const path = `${basePath}?fieldManager=${fieldManager}&force=true`;

  // A freshly provisioned cluster's API server briefly 5xxes while warming
  // up, and the creator's bootstrap access can propagate asynchronously
  // (401/403 in the first minute).
  return yield* requestJson({
    transport,
    method: "PATCH",
    path,
    body: object,
    redactions,
  }).pipe(
    Effect.retry({
      while: (e): boolean =>
        e instanceof KubernetesApiError &&
        (e.statusCode >= 500 ||
          e.statusCode === 429 ||
          e.statusCode === 401 ||
          e.statusCode === 403),
      schedule: Schedule.max([Schedule.spaced("6 seconds"), Schedule.recurs(10)]),
    }),
  );
});

export const deleteObject = Effect.fn(function* ({
  transport,
  object,
}: {
  transport: ClusterTransport;
  object: KubernetesObjectRef;
}) {
  yield* buildPath({ transport, object }).pipe(
    Effect.flatMap((path) =>
      requestJson({
        transport,
        method: "DELETE",
        // batch/v1 Jobs orphan their pods on DELETE unless a propagation
        // policy is set; Background matches kubectl's default.
        path: `${path}?propagationPolicy=Background`,
      }),
    ),
    Effect.catchTag("KubernetesNotFound", () => Effect.void),
  );
});

export const reconcileObjects = Effect.fn(function* ({
  transport,
  previousObjects,
  desiredObjects,
  redactions,
}: {
  transport: ClusterTransport;
  previousObjects: ReadonlyArray<KubernetesObjectRef>;
  desiredObjects: ReadonlyArray<KubernetesObjectDefinition>;
  redactions?: readonly string[];
}) {
  const desiredRefs = desiredObjects.map(toKubernetesObjectRef);
  const desiredKeys = new Set(desiredRefs.map(kubernetesObjectKey));

  const removedObjects = previousObjects.filter(
    (object) => !desiredKeys.has(kubernetesObjectKey(object)),
  );

  for (const object of sortRefsForDelete(removedObjects)) {
    yield* deleteObject({
      transport,
      object,
    });
  }

  const baselines = new Map<string, { baselineHash: string; driftMask: unknown }>();
  for (const chunk of chunkByApplyRank(desiredObjects)) {
    yield* Effect.forEach(
      chunk,
      (object) =>
        Effect.gen(function* () {
          const applied = yield* applyObject({
            transport,
            object,
            redactions,
          });
          const ref = toKubernetesObjectRef(object);
          const witnessed = isPlainObject(applied) ? applied : undefined;
          baselines.set(kubernetesObjectKey(ref), {
            driftMask: driftMask(object, witnessed),
            baselineHash: yield* hashDriftSelection(object, witnessed ?? object),
          });
        }),
      { concurrency: "unbounded" },
    );
  }

  return desiredRefs.map((ref) => ({
    ...ref,
    ...baselines.get(kubernetesObjectKey(ref)),
  }));
});

export const deleteObjects = Effect.fn(function* ({
  transport,
  objects,
}: {
  transport: ClusterTransport;
  objects: ReadonlyArray<KubernetesObjectRef>;
}) {
  for (const object of sortRefsForDelete(objects)) {
    yield* deleteObject({
      transport,
      object,
    });
  }
});
