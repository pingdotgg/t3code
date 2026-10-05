import * as Kubernetes from "alchemy/Kubernetes";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { Cluster, Namespace, Web } from "./infra.ts";

export default Kubernetes.Job(
  "HealthCheck",
  Effect.gen(function* () {
    const cluster = yield* Cluster;
    const namespace = yield* Namespace;
    return {
      cluster,
      main: import.meta.url,
      name: "health-check",
      namespace: namespace.name,
      schedule: "*/5 * * * *",
    };
  }),
  Effect.gen(function* () {
    const web = yield* Web;
    const webUrl =
      yield* Output.interpolate`http://${web.serviceName}.${web.namespace}.svc.cluster.local:${web.port}`;

    return {
      run: Effect.gen(function* () {
        const url = yield* webUrl;
        const response = yield* HttpClient.get(`${url}/healthz`).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.retry({
            schedule: Schedule.exponential("1 second"),
            times: 5,
          }),
        );
        yield* Effect.log(`${url} responded ${response.status}`);
      }).pipe(Effect.orDie),
    };
  }),
);
