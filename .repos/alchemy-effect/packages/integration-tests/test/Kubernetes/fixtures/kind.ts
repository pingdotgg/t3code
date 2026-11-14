import * as Kubernetes from "@alchemy.run/kubernetes";
import type { Connection } from "@alchemy.run/kubernetes/Connection";
import { expect } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

/**
 * A kind cluster for one Kubernetes test suite. Each suite gets its own
 * cluster name, registry port, and kubeconfig under `.alchemy/` so suites
 * run concurrently and never touch `~/.kube/config`.
 */
export const KindTestCluster = (suite: string, registryPort: number) =>
  Kubernetes.LocalCluster(`KindTestCluster`, {
    name: `alchemy-test-${suite}`,
    registryPort,
    kubeconfig: `.alchemy/test-${suite}.kubeconfig`,
  });

export type KindCluster = Kubernetes.LocalCluster["Attributes"];

/**
 * Run kubectl against the test cluster (out-of-band of alchemy) and return
 * stdout. A non-zero exit fails with stderr.
 */
export const kubectl = (cluster: KindCluster, args: string[], stdin?: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const result = yield* ChildProcess.make(
      "kubectl",
      [
        ...(cluster.kubeconfig ? ["--kubeconfig", cluster.kubeconfig] : []),
        "--context",
        cluster.context,
        ...args,
      ],
      {
        stdin: stdin === undefined ? "ignore" : Stream.make(new TextEncoder().encode(stdin)),
        stdout: "pipe",
        stderr: "pipe",
      },
    ).pipe(
      spawner.spawn,
      Effect.flatMap((child) =>
        Effect.all(
          {
            exitCode: child.exitCode,
            stdout: child.stdout.pipe(Stream.decodeText, Stream.mkString),
            stderr: child.stderr.pipe(Stream.decodeText, Stream.mkString),
          },
          { concurrency: "unbounded" },
        ),
      ),
      Effect.scoped,
    );
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new Error(`kubectl ${args.join(" ")} exited ${String(result.exitCode)}: ${result.stderr}`),
      );
    }
    return result.stdout;
  });

/** Names of the kind clusters on this machine (out-of-band of alchemy). */
export const kindClusters = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.lines(ChildProcess.make("kind", ["get", "clusters"]));
});

/** Names of all Docker containers on this machine. */
export const dockerContainers = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.lines(
    ChildProcess.make("docker", ["ps", "--all", "--format", "{{.Names}}"]),
  );
});

/**
 * Destroy the cluster stack and verify out-of-band that the kind cluster
 * and its registry container are gone.
 */
export const destroyKindStack = (
  stack: { destroy: () => Effect.Effect<void, any, never> },
  cluster: KindCluster | undefined,
) =>
  Effect.gen(function* () {
    yield* stack.destroy();
    if (cluster === undefined) return;
    expect(yield* kindClusters).not.toContain(cluster.name);
    expect(yield* dockerContainers).not.toContain(cluster.registryContainer);
  });

/** GET an object as JSON through kubectl, or `undefined` when it is absent. */
export const kubectlGet = (cluster: KindCluster, args: string[]) =>
  kubectl(cluster, ["get", ...args, "--ignore-not-found", "-o", "json"]).pipe(
    Effect.map((stdout) => (stdout.trim() === "" ? undefined : (JSON.parse(stdout) as any))),
  );

/** Decode a base64 Secret value. */
export const decodeBase64 = (value: string) =>
  Effect.sync(() => Buffer.from(value, "base64").toString("utf8"));

export interface RbacRule {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
}

const rbacObjects = (name: string, rules: RbacRule[]) =>
  JSON.stringify({
    apiVersion: "v1",
    kind: "List",
    items: [
      {
        apiVersion: "v1",
        kind: "ServiceAccount",
        metadata: { name, namespace: "default" },
      },
      {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "Role",
        metadata: { name, namespace: "default" },
        rules,
      },
      {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "RoleBinding",
        metadata: { name, namespace: "default" },
        roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name },
        subjects: [{ kind: "ServiceAccount", name, namespace: "default" }],
      },
    ],
  });

/**
 * Create (or update) a ServiceAccount bound to a Role with exactly `rules`,
 * mint a bearer token for it, and return a token-auth {@link Connection}
 * against the cluster's API server. Re-running with new rules updates the
 * Role in place (RBAC changes apply to the existing token).
 */
export const restrictedConnection = (cluster: KindCluster, name: string, rules: RbacRule[]) =>
  Effect.gen(function* () {
    yield* kubectl(cluster, ["apply", "-f", "-"], rbacObjects(name, rules));
    const token = yield* kubectl(cluster, [
      "create",
      "token",
      name,
      "--namespace",
      "default",
      "--duration",
      "1h",
    ]);
    const server = yield* kubectl(cluster, [
      "config",
      "view",
      "--raw",
      "--minify",
      "-o",
      "jsonpath={.clusters[0].cluster.server}",
    ]);
    const ca = yield* kubectl(cluster, [
      "config",
      "view",
      "--raw",
      "--minify",
      "-o",
      "jsonpath={.clusters[0].cluster.certificate-authority-data}",
    ]);
    return {
      endpoint: server.trim(),
      certificateAuthorityData: ca.trim(),
      auth: { kind: "token", token: token.trim() },
    } satisfies Connection as Connection;
  });

/** Update the Role created by {@link restrictedConnection}. */
export const updateRole = (cluster: KindCluster, name: string, rules: RbacRule[]) =>
  kubectl(cluster, ["apply", "-f", "-"], rbacObjects(name, rules));

/** Remove the ServiceAccount, Role, and RoleBinding. */
export const removeRbac = (cluster: KindCluster, name: string) =>
  kubectl(cluster, [
    "delete",
    "serviceaccount,role,rolebinding",
    name,
    "--namespace",
    "default",
    "--ignore-not-found",
  ]);
