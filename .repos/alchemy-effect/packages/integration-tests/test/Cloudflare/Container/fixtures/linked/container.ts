import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

declare const BUNDLE_MARKER: string;

export class LinkedContainer extends Cloudflare.Container<
  LinkedContainer,
  { marker: () => Effect.Effect<string> }
>()("LinkedContainer") {}

/**
 * A generated-Dockerfile container whose bundle bytes change with `marker`,
 * so each entrypoint publishes a new image over the same base layers.
 */
export const linkedContainer = (main: string, marker: string) =>
  LinkedContainer.make(
    {
      main,
      image: "oven/bun:latest",
      build: { input: { transform: { define: { BUNDLE_MARKER: JSON.stringify(marker) } } } },
    },
    Effect.sync(() => {
      // Only the bundle defines the marker; deploy-time runs see the argument.
      const bundled = typeof BUNDLE_MARKER === "string" ? BUNDLE_MARKER : marker;
      return {
        marker: () => Effect.succeed(bundled),
        fetch: Effect.succeed(HttpServerResponse.text(bundled)),
      };
    }),
  );
