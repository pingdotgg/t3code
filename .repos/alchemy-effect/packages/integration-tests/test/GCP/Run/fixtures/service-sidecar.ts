import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * Effect-native Cloud Run Service with an HTTP startup probe that starts
 * after an nginx sidecar. Deployed from {@link ../Service.test.ts}.
 */
export default class SidecarService extends GCP.Run.Service<SidecarService>()(
  "SidecarService",
  {
    main: import.meta.url,
    location: "us-central1",
    invokerIamDisabled: true,
    template: {
      containers: [
        {
          startupProbe: { httpGet: { path: "/health" }, periodSeconds: 2, failureThreshold: 30 },
          dependsOn: ["sidecar"],
        },
        {
          name: "sidecar",
          image: "docker.io/library/nginx:1.27-alpine",
          startupProbe: { tcpSocket: { port: 80 }, periodSeconds: 2, failureThreshold: 30 },
        },
      ],
    },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/health")) return HttpServerResponse.text("ok");
        return HttpServerResponse.text("hello");
      }),
    };
  }),
) {}
