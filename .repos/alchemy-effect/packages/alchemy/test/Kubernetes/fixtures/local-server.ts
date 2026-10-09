import * as Kubernetes from "@/Kubernetes";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { TestLocalCluster } from "./local.ts";

/** An Effect HTTP server run as a Deployment on the local cluster. */
export default Kubernetes.Deployment(
  "LocalEffectServer",
  Effect.gen(function* () {
    const cluster = yield* TestLocalCluster;
    return {
      cluster,
      main: import.meta.url,
      name: "local-effect-server",
      port: 3000,
      serviceType: "ClusterIP" as const,
    };
  }),
  Effect.gen(function* () {
    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }),
);
