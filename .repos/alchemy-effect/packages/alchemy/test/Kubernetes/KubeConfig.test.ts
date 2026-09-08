import * as Kubernetes from "@/Kubernetes";
import { connectCluster } from "@/Kubernetes/internal/client.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

// The kubeconfig adapter resolved against a REAL kubeconfig file on disk,
// including a REAL exec credential plugin invocation (`echo` prints the
// ExecCredential JSON) — the same path `aws eks get-token` / `kubelogin` /
// `gke-gcloud-auth-plugin` contexts take.
const describe = layer(
  Layer.provideMerge(Kubernetes.KubeConfigAdapter, NodeServices.layer),
);

const CA_PEM = "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n";

const execCredential = JSON.stringify({
  apiVersion: "client.authentication.k8s.io/v1",
  kind: "ExecCredential",
  status: { token: "exec-minted-token" },
});

const kubeconfig = `
apiVersion: v1
kind: Config
current-context: token-ctx
clusters:
  - name: token-cluster
    cluster:
      server: https://token.example:6443
      certificate-authority-data: ${Buffer.from(CA_PEM).toString("base64")}
  - name: exec-cluster
    cluster:
      server: https://exec.example:6443
      insecure-skip-tls-verify: true
users:
  - name: token-user
    user:
      token: static-test-token
  - name: exec-user
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1
        command: echo
        args:
          - '${execCredential}'
contexts:
  - name: token-ctx
    context:
      cluster: token-cluster
      user: token-user
  - name: exec-ctx
    context:
      cluster: exec-cluster
      user: exec-user
`;

const writeKubeconfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectory({ prefix: "alchemy-kubeconfig-" });
  const file = path.join(dir, "config");
  yield* fs.writeFileString(file, kubeconfig);
  return file;
});

describe("Kubernetes.KubeConfig", (it) => {
  it.effect("resolves the current-context's cluster and static token", () =>
    Effect.gen(function* () {
      const file = yield* writeKubeconfig;
      const transport = yield* connectCluster(
        Kubernetes.KubeConfig({ path: file }),
      );
      expect(transport.endpoint).toBe("https://token.example:6443");
      expect(
        Buffer.from(transport.certificateAuthorityData!, "base64").toString(
          "utf8",
        ),
      ).toBe(CA_PEM);
      const headers = yield* transport.headers;
      expect(headers.Authorization).toBe("Bearer static-test-token");
    }),
  );

  it.effect("mints credentials through an exec plugin context", () =>
    Effect.gen(function* () {
      const file = yield* writeKubeconfig;
      const transport = yield* connectCluster(
        Kubernetes.KubeConfig({ path: file, context: "exec-ctx" }),
      );
      expect(transport.endpoint).toBe("https://exec.example:6443");
      expect(transport.insecureSkipTlsVerify).toBe(true);
      const headers = yield* transport.headers;
      expect(headers.Authorization).toBe("Bearer exec-minted-token");
    }),
  );

  it.effect("an unknown context fails with a typed KubeConfigError", () =>
    Effect.gen(function* () {
      const file = yield* writeKubeconfig;
      const result = yield* Effect.result(
        connectCluster(
          Kubernetes.KubeConfig({ path: file, context: "missing" }),
        ),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});
