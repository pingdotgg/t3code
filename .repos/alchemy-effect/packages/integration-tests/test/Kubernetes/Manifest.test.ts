import * as AWS from "@alchemy.run/aws";
import * as Kubernetes from "@alchemy.run/kubernetes";
import type { Connection } from "@alchemy.run/kubernetes/Connection";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Drift from "alchemy/Drift";
import * as Provider from "alchemy/Provider";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import {
  decodeBase64,
  destroyKindStack,
  KindTestCluster,
  kubectl,
  kubectlGet,
  removeRbac,
  restrictedConnection,
  updateRole,
  type KindCluster,
} from "./fixtures/kind.ts";

const testOptions = {
  providers: Layer.mergeAll(AWS.providers(), Kubernetes.providers()),
};
const { test, beforeAll, afterAll } = Test.make(testOptions);

const tags = ["provider:kubernetes", "provider:kubernetes:manifest"];

// Ungated probe: `Manifest` applies in-cluster objects that have no
// cloud-side enumeration attributing them to alchemy, so `list()` is
// intentionally empty. The probe proves the provider is registered and its
// record type-checks.
test.provider(
  "list returns an empty array (in-cluster objects)",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(Kubernetes.Manifest);
      const all = yield* provider.list();
      expect(Array.isArray(all)).toBe(true);
      expect(all).toEqual([]);
    }),
  {
    tags: ["provider:aws", ...tags, "live"],
  },
);

const configMap = (name: string, data: Record<string, unknown>) => ({
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name, namespace: "default" },
  data,
});

/**
 * A local TCP listener that accepts connections and never answers — not
 * even the TLS handshake. It stands in for an API server whose load
 * balancer or network has gone dark; it never returns an HTTP response.
 */
const blackhole = Effect.gen(function* () {
  const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 });
  const arrivals = yield* Ref.make<number[]>([]);
  const open = yield* Ref.make(0);
  yield* server
    .run((socket) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* Ref.update(arrivals, (all) => [...all, now]);
        yield* Ref.update(open, (n) => n + 1);
        const reader = yield* socket.reader;
        yield* reader.pull.pipe(Effect.forever);
      }).pipe(Effect.scoped, Effect.ignore, Effect.ensuring(Ref.update(open, (n) => n - 1))),
    )
    .pipe(Effect.forkScoped);
  const port = server.address._tag === "InetAddressV4" ? server.address.port : 0;
  return { endpoint: `https://127.0.0.1:${port}`, arrivals, open };
});

test.provider(
  "a stalled API server fails each attempt at the deadline and interruption releases the socket",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { endpoint, arrivals, open } = yield* blackhole;
      const cluster: Connection = {
        endpoint,
        insecureSkipTlsVerify: true,
        auth: { kind: "token", token: "unused" },
      };
      const deploying = yield* stack
        .deploy(
          Kubernetes.Manifest("Stalled", {
            cluster,
            manifest: configMap("stalled", { key: "value" }),
          }),
        )
        .pipe(Effect.forkChild);

      // The first attempt hangs; the 10s attempt deadline aborts it and the
      // retry opens a second connection.
      const seen = yield* Ref.get(arrivals).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (all) => all.length >= 2,
          times: 40,
        }),
      );
      expect(seen.length).toBeGreaterThanOrEqual(2);
      const gap = seen[1]! - seen[0]!;
      // 10s attempt deadline + 5s retry spacing.
      expect(gap).toBeGreaterThan(8_000);
      expect(gap).toBeLessThan(22_000);

      // Interrupting the stalled deploy returns promptly instead of waiting
      // out the attempt.
      expect(yield* Ref.get(open)).toBeGreaterThanOrEqual(1);
      const before = yield* Clock.currentTimeMillis;
      yield* Fiber.interrupt(deploying);
      const after = yield* Clock.currentTimeMillis;
      expect(after - before).toBeLessThan(3_000);

      // ...and destroys the socket instead of leaving it to the server.
      const remaining = yield* Ref.get(open).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("200 millis"),
          until: (n) => n === 0,
          times: 25,
        }),
      );
      expect(remaining).toBe(0);

      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: [...tags, "local"], timeout: 90_000 },
);

test.provider(
  "a stalled credential plugin fails at the header deadline",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-k8s-exec-" });
      const marker = path.join(dir, "minted");
      // A real exec credential plugin: the first call (at connect) mints an
      // already-expired token, so the request re-mints and the plugin hangs.
      const credential = JSON.stringify({
        apiVersion: "client.authentication.k8s.io/v1",
        kind: "ExecCredential",
        status: { token: "expired", expirationTimestamp: "2000-01-01T00:00:00Z" },
      });
      const cluster: Connection = {
        endpoint: "https://127.0.0.1:9",
        insecureSkipTlsVerify: true,
        auth: {
          kind: "exec",
          command: "sh",
          args: [
            "-c",
            `if [ -e "$1" ]; then exec sleep 600; fi; : > "$1"; printf '%s' '${credential}'`,
            "sh",
            marker,
          ],
        },
      };
      const before = yield* Clock.currentTimeMillis;
      const exit = yield* Effect.exit(
        stack.deploy(
          Kubernetes.Manifest("StalledMint", {
            cluster,
            manifest: configMap("stalled-mint", { key: "value" }),
          }),
        ),
      );
      const elapsed = (yield* Clock.currentTimeMillis) - before;
      expect(Exit.isFailure(exit)).toBe(true);
      expect(elapsed).toBeGreaterThan(8_000);
      expect(elapsed).toBeLessThan(25_000);
      expect(yield* fs.exists(marker)).toBe(true);

      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: [...tags, "local"], timeout: 90_000 },
);

const kindStack = Core.scratchStack(testOptions, "KubernetesManifestKind");

// Creates a real kind cluster (~30s); needs Docker, kind, and kubectl.
describe(
  "Kubernetes Manifest on kind",
  { tags: [...tags, "provider:kubernetes:localcluster", "live"] },
  () => {
    let cluster: KindCluster;

    beforeAll(
      Effect.gen(function* () {
        yield* kindStack.destroy();
        cluster = yield* kindStack.deploy(KindTestCluster("manifest", 5062));
      }),
      { timeout: 300_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(
      Effect.suspend(() => destroyKindStack(kindStack, cluster)),
      { timeout: 180_000 },
    );

    test.provider(
      "Redacted Secret values are applied unwrapped and compared without false drift",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const leaf = "manifest-leaf-sentinel";
          const encoded = "manifest-data-sentinel";
          const nested = "manifest-nested-sentinel";
          const program = Effect.gen(function* () {
            yield* Kubernetes.Manifest("LeafSecret", {
              cluster: cluster.connection,
              manifest: {
                apiVersion: "v1",
                kind: "Secret",
                metadata: { name: "leaf-secret", namespace: "default" },
                stringData: { token: Redacted.make(leaf) },
              },
            });
            yield* Kubernetes.Manifest("DataSecret", {
              cluster: cluster.connection,
              manifest: {
                apiVersion: "v1",
                kind: "Secret",
                metadata: { name: "data-secret", namespace: "default" },
                data: { token: Redacted.make(Buffer.from(encoded).toString("base64")) },
              },
            });
            yield* Kubernetes.Manifest("ContainerSecret", {
              cluster: cluster.connection,
              manifest: {
                apiVersion: "v1",
                kind: "Secret",
                metadata: { name: "container-secret", namespace: "default" },
                stringData: Redacted.make({ token: leaf, nested }),
              },
            });
          });
          yield* stack.deploy(program);

          const readToken = (name: string, key = "token") =>
            kubectlGet(cluster, ["secret", name, "--namespace", "default"]).pipe(
              Effect.flatMap((secret) => decodeBase64(secret.data[key])),
            );
          expect(yield* readToken("leaf-secret")).toBe(leaf);
          expect(yield* readToken("data-secret")).toBe(encoded);
          expect(yield* readToken("container-secret")).toBe(leaf);
          expect(yield* readToken("container-secret", "nested")).toBe(nested);

          // Write-only stringData compares against the stored base64 data.
          const steady = yield* Drift.detect({ name: stack.name, stage: stack.stage });
          expect(steady.resources.LeafSecret?.action).toBe("unchanged");
          expect(steady.resources.DataSecret?.action).toBe("unchanged");
          expect(steady.resources.ContainerSecret?.action).toBe("unchanged");

          const replaced = yield* Effect.sync(() => Buffer.from("edited").toString("base64"));
          yield* kubectl(cluster, [
            "patch",
            "secret",
            "leaf-secret",
            "--namespace",
            "default",
            "--type",
            "merge",
            "-p",
            JSON.stringify({ data: { token: replaced } }),
          ]);
          const edited = yield* Drift.detect({ name: stack.name, stage: stack.stage });
          expect(edited.resources.LeafSecret?.action).toBe("drifted");
          expect(edited.resources.DataSecret?.action).toBe("unchanged");
          expect(edited.resources.ContainerSecret?.action).toBe("unchanged");

          yield* stack.destroy();
          for (const name of ["leaf-secret", "data-secret", "container-secret"]) {
            expect(yield* kubectlGet(cluster, ["secret", name, "--namespace", "default"])).toBe(
              undefined,
            );
          }
        }),
      { timeout: 180_000 },
    );

    test.provider(
      "an API rejection does not surface Redacted values",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          // The apiserver echoes an invalid `spec.type` back in its 422 body,
          // Go-quoted — the quotes exercise the JSON-escaped form too.
          const leaf = 'leaf-redact-sentinel-"q"';
          const nested = 'nested-redact-sentinel-"q"';
          const rejected = (id: string, manifest: Kubernetes.KubernetesManifest) =>
            Effect.gen(function* () {
              const exit = yield* Effect.exit(
                stack.deploy(Kubernetes.Manifest(id, { cluster: cluster.connection, manifest })),
              );
              expect(Exit.isFailure(exit)).toBe(true);
              return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
            });

          const leafError = yield* rejected("LeafRejected", {
            apiVersion: "v1",
            kind: "Service",
            metadata: { name: "leaf-rejected", namespace: "default" },
            spec: { type: Redacted.make(leaf), ports: [{ port: 80 }] },
          });
          expect(leafError).toContain("spec.type");
          expect(leafError).toContain("leaf-rejected");
          expect(leafError).toContain("<redacted>");
          expect(leafError).not.toContain("redact-sentinel");
          expect(leafError).not.toContain(Buffer.from(leaf).toString("base64"));

          const containerError = yield* rejected("ContainerRejected", {
            apiVersion: "v1",
            kind: "Service",
            metadata: { name: "container-rejected", namespace: "default" },
            spec: Redacted.make({ type: nested, ports: [{ port: 80 }] }),
          });
          expect(containerError).toContain("spec.type");
          expect(containerError).toContain("container-rejected");
          expect(containerError).toContain("<redacted>");
          expect(containerError).not.toContain("redact-sentinel");
          expect(containerError).not.toContain(Buffer.from(nested).toString("base64"));

          yield* stack.destroy();
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "destroy tolerates an object deleted out of band",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          yield* stack.deploy(
            Kubernetes.Manifest("Vanished", {
              cluster: cluster.connection,
              manifest: configMap("vanished", { key: "value" }),
            }),
          );
          yield* kubectl(cluster, ["delete", "configmap", "vanished", "--namespace", "default"]);
          yield* stack.destroy();
          expect(
            yield* kubectlGet(cluster, ["configmap", "vanished", "--namespace", "default"]),
          ).toBe(undefined);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "destroy surfaces a 403 and leaves the object in place",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const account = "manifest-no-delete";
          const rules = (verbs: string[]) => [
            { apiGroups: [""], resources: ["configmaps"], verbs },
          ];
          const restricted = yield* restrictedConnection(
            cluster,
            account,
            rules(["get", "list", "create", "patch", "update"]),
          );
          yield* stack.deploy(
            Kubernetes.Manifest("Kept", {
              cluster: restricted,
              manifest: configMap("kept", { key: "value" }),
            }),
          );

          const exit = yield* Effect.exit(stack.destroy());
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("403");
          }
          expect(
            yield* kubectlGet(cluster, ["configmap", "kept", "--namespace", "default"]),
          ).toBeDefined();

          // Granting delete lets the same destroy converge.
          yield* updateRole(
            cluster,
            account,
            rules(["get", "list", "create", "patch", "update", "delete"]),
          );
          yield* stack
            .destroy()
            .pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 5 }));
          expect(yield* kubectlGet(cluster, ["configmap", "kept", "--namespace", "default"])).toBe(
            undefined,
          );
          yield* removeRbac(cluster, account);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "drift reports declared-field edits and ignores fields alchemy does not own",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const image = "registry.k8s.io/pause:3.10";
          const deployment = (
            name: string,
            options: {
              replicas?: number;
              annotations?: Record<string, string>;
              templateAnnotations?: Record<string, string>;
              spec?: Record<string, unknown>;
            } = {},
          ): Kubernetes.KubernetesManifest => ({
            apiVersion: "apps/v1",
            kind: "Deployment",
            metadata: {
              name,
              namespace: "default",
              ...(options.annotations ? { annotations: options.annotations } : {}),
            },
            spec: {
              ...(options.replicas !== undefined ? { replicas: options.replicas } : {}),
              selector: { matchLabels: { app: name } },
              template: {
                metadata: {
                  labels: { app: name },
                  ...(options.templateAnnotations
                    ? { annotations: options.templateAnnotations }
                    : {}),
                },
                spec: options.spec ?? { containers: [{ name: "app", image }] },
              },
            },
          });
          const manifests: Record<string, Kubernetes.KubernetesManifest> = {
            // Undeclared replicas (an HPA scales them) and canonicalized
            // quantities ("0.1" → "100m", "1.5Gi" → "1536Mi").
            Scaled: deployment("drift-scaled", {
              spec: {
                containers: [
                  {
                    name: "app",
                    image,
                    resources: { requests: { cpu: "0.1", memory: "1.5Gi" } },
                  },
                ],
              },
            }),
            Image: deployment("drift-image"),
            Replicas: deployment("drift-replicas", { replicas: 1 }),
            RootEdit: deployment("drift-root-edit", { annotations: { app: "web" } }),
            RootDrop: deployment("drift-root-drop", { annotations: { app: "web" } }),
            TemplateEdit: deployment("drift-template-edit", {
              templateAnnotations: { "prometheus.io/scrape": "true" },
            }),
            TemplateDrop: deployment("drift-template-drop", {
              templateAnnotations: { "prometheus.io/scrape": "true" },
            }),
            // The controller stamps deployment.kubernetes.io/revision.
            Controller: deployment("drift-controller", { annotations: { app: "web" } }),
            InitOrder: deployment("drift-init-order", {
              spec: {
                initContainers: [
                  { name: "a", image },
                  { name: "b", image },
                ],
                containers: [{ name: "app", image }],
              },
            }),
            DataEdit: configMap("drift-data-edit", { token: "declared" }),
            Steady: configMap("drift-steady", { token: "declared" }),
          };
          const program = Effect.forEach(
            Object.entries(manifests),
            ([id, manifest]) => Kubernetes.Manifest(id, { cluster: cluster.connection, manifest }),
            { discard: true },
          );
          yield* stack.deploy(program);

          const detect = Drift.detect({ name: stack.name, stage: stack.stage });
          const baseline = yield* detect;
          for (const id of Object.keys(manifests)) {
            expect({ id, action: baseline.resources[id]?.action }).toEqual({
              id,
              action: "unchanged",
            });
          }

          const ns = ["--namespace", "default"];
          yield* kubectl(cluster, [
            "scale",
            "deployment",
            "drift-scaled",
            "--replicas",
            "3",
            ...ns,
          ]);
          yield* kubectl(cluster, [
            "set",
            "image",
            "deployment/drift-image",
            "app=registry.k8s.io/pause:3.9",
            ...ns,
          ]);
          yield* kubectl(cluster, [
            "scale",
            "deployment",
            "drift-replicas",
            "--replicas",
            "3",
            ...ns,
          ]);
          yield* kubectl(cluster, [
            "annotate",
            "deployment",
            "drift-root-edit",
            "app=api",
            "--overwrite",
            ...ns,
          ]);
          yield* kubectl(cluster, ["annotate", "deployment", "drift-root-drop", "app-", ...ns]);
          yield* kubectl(cluster, [
            "patch",
            "deployment",
            "drift-template-edit",
            "--type",
            "merge",
            "-p",
            JSON.stringify({
              spec: {
                template: { metadata: { annotations: { "prometheus.io/scrape": "false" } } },
              },
            }),
            ...ns,
          ]);
          yield* kubectl(cluster, [
            "patch",
            "deployment",
            "drift-template-drop",
            "--type",
            "json",
            "-p",
            JSON.stringify([
              {
                op: "remove",
                path: "/spec/template/metadata/annotations/prometheus.io~1scrape",
              },
            ]),
            ...ns,
          ]);
          yield* kubectl(cluster, [
            "annotate",
            "deployment",
            "drift-controller",
            "example.com/owner=someone-else",
            ...ns,
          ]);
          yield* kubectl(cluster, [
            "patch",
            "deployment",
            "drift-init-order",
            "--type",
            "json",
            "-p",
            JSON.stringify([
              {
                op: "replace",
                path: "/spec/template/spec/initContainers",
                value: [
                  { name: "b", image },
                  { name: "a", image },
                ],
              },
            ]),
            ...ns,
          ]);
          yield* kubectl(cluster, [
            "patch",
            "configmap",
            "drift-data-edit",
            "--type",
            "merge",
            "-p",
            JSON.stringify({ data: { token: "edited" } }),
            ...ns,
          ]);
          const controller = yield* kubectlGet(cluster, ["deployment", "drift-controller", ...ns]);
          expect(controller.metadata.annotations["deployment.kubernetes.io/revision"]).toBe("1");
          const steadyVersion = (yield* kubectlGet(cluster, ["configmap", "drift-steady", ...ns]))
            .metadata.resourceVersion;

          const after = yield* detect;
          const expected: Record<string, "drifted" | "unchanged"> = {
            Scaled: "unchanged",
            Image: "drifted",
            Replicas: "drifted",
            RootEdit: "drifted",
            RootDrop: "drifted",
            TemplateEdit: "drifted",
            TemplateDrop: "drifted",
            Controller: "unchanged",
            InitOrder: "unchanged",
            DataEdit: "drifted",
            Steady: "unchanged",
          };
          for (const [id, action] of Object.entries(expected)) {
            expect({ id, action: after.resources[id]?.action }).toEqual({ id, action });
          }
          // Drift reads are GETs: the untouched object was not written.
          expect(
            (yield* kubectlGet(cluster, ["configmap", "drift-steady", ...ns])).metadata
              .resourceVersion,
          ).toBe(steadyVersion);

          yield* stack.destroy();
          for (const manifest of Object.values(manifests)) {
            expect(
              yield* kubectlGet(cluster, [
                manifest.kind.toLowerCase(),
                manifest.metadata!.name!,
                ...ns,
              ]),
            ).toBe(undefined);
          }
        }),
      { timeout: 180_000 },
    );
  },
);
