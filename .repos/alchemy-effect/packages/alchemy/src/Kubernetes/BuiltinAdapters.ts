/**
 * The built-in {@link ClusterAdapter} implementations shipped by
 * `Kubernetes.providers()`: `kubeconfig`, `token`, `client-cert`, and
 * `exec`. They cover any cluster `kubectl` can reach; managed-cloud
 * adapters (EKS's `aws-eks`) are contributed by their provider layers.
 *
 * These adapters are auth-only — no workload identity and no managed image
 * registry. Workloads on such clusters bind through environment variables
 * and run pre-built `image` references (or images pushed by the user's own
 * pipeline).
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import {
  ClusterAdapter,
  type ClusterAdapterService,
  type ClusterTransport,
} from "./ClusterAdapter.ts";
import type { Connection } from "./Connection.ts";
import {
  mintUserCredentials,
  resolveKubeContext,
  runExecCredential,
  type MintedCredentials,
} from "./internal/kubeconfig.ts";

const toAuthHeaders = (
  credentials: MintedCredentials,
): Record<string, string> =>
  credentials.token ? { Authorization: `Bearer ${credentials.token}` } : {};

const requireEndpoint = (connection: Connection) =>
  connection.endpoint !== undefined
    ? Effect.succeed(connection.endpoint)
    : Effect.fail(
        new Error(
          `A '${connection.auth.kind}' Kubernetes connection requires an ` +
            "explicit `endpoint` (only kubeconfig-backed and managed-cloud " +
            "connections can discover it)",
        ),
      );

/**
 * `kubeconfig` — resolve the cluster and credentials from a kubeconfig
 * file, honoring static tokens, client certificates, and `exec` credential
 * plugins.
 */
export const KubeConfigAdapter: Layer.Layer<
  ClusterAdapterService,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  ClusterAdapter("kubeconfig"),
  Effect.gen(function* () {
    // Capture the platform services at layer build so per-request minting
    // (exec plugins can re-run on token expiry) needs no ambient context.
    const context = yield* Effect.context<
      | FileSystem.FileSystem
      | Path.Path
      | ChildProcessSpawner.ChildProcessSpawner
    >();

    return {
      kind: "Kubernetes.ClusterAdapter" as const,
      connect: Effect.fn(function* (connection: Connection) {
        if (connection.auth.kind !== "kubeconfig") {
          return yield* Effect.die(
            new Error(
              `kubeconfig adapter received auth kind '${connection.auth.kind}'`,
            ),
          );
        }
        const resolved = yield* resolveKubeContext({
          path: connection.auth.path,
          context: connection.auth.context,
        }).pipe(Effect.provideContext(context));

        // Mint once at connect: static tokens and client certificates are
        // stable; exec plugins re-mint per request below (their tokens
        // expire) but any plugin-issued client certificate is captured
        // here.
        const initial = yield* mintUserCredentials(resolved.user).pipe(
          Effect.provideContext(context),
        );

        const isExec = resolved.user.exec?.command !== undefined;
        const headers: ClusterTransport["headers"] = isExec
          ? mintUserCredentials(resolved.user).pipe(
              Effect.map(toAuthHeaders),
              Effect.provideContext(context),
            )
          : Effect.succeed(toAuthHeaders(initial));

        return {
          endpoint: connection.endpoint ?? resolved.endpoint,
          certificateAuthorityData:
            connection.certificateAuthorityData ??
            resolved.certificateAuthorityData,
          insecureSkipTlsVerify:
            connection.insecureSkipTlsVerify ?? resolved.insecureSkipTlsVerify,
          headers,
          clientCert: initial.clientCert,
        } satisfies ClusterTransport;
      }),
    };
  }),
);

/** `token` — a static bearer token against an explicit endpoint. */
export const TokenAdapter: Layer.Layer<ClusterAdapterService> = Layer.succeed(
  ClusterAdapter("token"),
  {
    kind: "Kubernetes.ClusterAdapter" as const,
    connect: Effect.fn(function* (connection: Connection) {
      if (connection.auth.kind !== "token") {
        return yield* Effect.die(
          new Error(
            `token adapter received auth kind '${connection.auth.kind}'`,
          ),
        );
      }
      const token = connection.auth.token;
      return {
        endpoint: yield* requireEndpoint(connection),
        certificateAuthorityData: connection.certificateAuthorityData,
        insecureSkipTlsVerify: connection.insecureSkipTlsVerify,
        headers: Effect.succeed({ Authorization: `Bearer ${token}` }),
      } satisfies ClusterTransport;
    }),
  },
);

/** `client-cert` — mutual TLS against an explicit endpoint. */
export const ClientCertAdapter: Layer.Layer<ClusterAdapterService> =
  Layer.succeed(ClusterAdapter("client-cert"), {
    kind: "Kubernetes.ClusterAdapter" as const,
    connect: Effect.fn(function* (connection: Connection) {
      if (connection.auth.kind !== "client-cert") {
        return yield* Effect.die(
          new Error(
            `client-cert adapter received auth kind '${connection.auth.kind}'`,
          ),
        );
      }
      return {
        endpoint: yield* requireEndpoint(connection),
        certificateAuthorityData: connection.certificateAuthorityData,
        insecureSkipTlsVerify: connection.insecureSkipTlsVerify,
        headers: Effect.succeed({}),
        clientCert: {
          certificate: connection.auth.certificate,
          key: connection.auth.key,
        },
      } satisfies ClusterTransport;
    }),
  });

/**
 * `exec` — mint credentials with a kubeconfig-style exec credential plugin
 * against an explicit endpoint.
 */
export const ExecAdapter: Layer.Layer<
  ClusterAdapterService,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  ClusterAdapter("exec"),
  Effect.gen(function* () {
    const context =
      yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();

    return {
      kind: "Kubernetes.ClusterAdapter" as const,
      connect: Effect.fn(function* (connection: Connection) {
        if (connection.auth.kind !== "exec") {
          return yield* Effect.die(
            new Error(
              `exec adapter received auth kind '${connection.auth.kind}'`,
            ),
          );
        }
        const exec = connection.auth;
        const initial = yield* runExecCredential(exec).pipe(
          Effect.provideContext(context),
        );
        return {
          endpoint: yield* requireEndpoint(connection),
          certificateAuthorityData: connection.certificateAuthorityData,
          insecureSkipTlsVerify: connection.insecureSkipTlsVerify,
          headers: runExecCredential(exec).pipe(
            Effect.map(toAuthHeaders),
            Effect.provideContext(context),
          ),
          clientCert: initial.clientCert,
        } satisfies ClusterTransport;
      }),
    };
  }),
);

/** All built-in adapters, merged for `Kubernetes.providers()`. */
export const builtinAdapters = (): Layer.Layer<
  ClusterAdapterService,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Layer.mergeAll(
    KubeConfigAdapter,
    TokenAdapter,
    ClientCertAdapter,
    ExecAdapter,
  );
