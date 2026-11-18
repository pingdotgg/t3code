import * as Kubernetes from "@alchemy.run/kubernetes";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { TestLocalCluster } from "./local.ts";

/** An Effect HTTP server run as a Deployment on the local cluster. */
export default Kubernetes.Deployment(
  "LocalEffectServer",
  // `cluster` takes the cluster resource's Effect directly.
  {
    cluster: TestLocalCluster,
    main: import.meta.url,
    name: "local-effect-server",
    port: 3000,
    serviceType: "ClusterIP",
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }),
);
