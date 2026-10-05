import * as Alchemy from "alchemy";
import { Stage } from "alchemy";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Effect from "effect/Effect";
import HealthCheck from "./src/HealthCheck.ts";
import SmokeTest from "./src/SmokeTest.ts";
import { Cluster, Web } from "./src/infra.ts";

export default Alchemy.Stack(
  "MyCluster",
  {
    providers: Kubernetes.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const cluster = yield* Cluster;
    const web = yield* Web;
    const smokeTest = yield* SmokeTest;
    yield* HealthCheck;

    const stage = yield* Stage;
    if (stage !== "prod") {
      yield* Kubernetes.HelmChart("MetricsServer", {
        cluster,
        chart: "metrics-server",
        repo: "https://kubernetes-sigs.github.io/metrics-server/",
        version: "3.14.0",
        releaseName: "metrics-server",
        namespace: "kube-system",
        values: {
          args: ["--kubelet-insecure-tls"],
        },
      });
    }

    return {
      namespace: web.namespace,
      service: web.serviceName,
      smokeTest: smokeTest.jobName,
    };
  }),
);
