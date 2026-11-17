import * as GCP from "@alchemy.run/gcp";

/** An image-only sidecar, reached through `GCP.Run.bindPort`. */
export const Static = GCP.Run.Container("Static", {
  image: "docker.io/library/nginx:1.27-alpine",
  port: 80,
  startupProbe: { tcpSocket: {}, periodSeconds: 2, failureThreshold: 30 },
});
