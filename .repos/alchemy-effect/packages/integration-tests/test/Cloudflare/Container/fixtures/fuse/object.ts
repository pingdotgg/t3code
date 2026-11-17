import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

/**
 * Container that mounts a FUSE filesystem at boot and serves a file read
 * through the mount (see `context/start.sh`).
 */
class FuseContainer extends Cloudflare.Container<FuseContainer>()("FuseContainer", {
  // Template string, not `path.join(import.meta.dirname, …)`: this module is
  // bundled into the Worker and `import.meta.dirname` is undefined there.
  context: `${import.meta.dirname}/context`,
  observability: { logs: { enabled: true } },
}) {}

/** Durable Object that starts the {@link FuseContainer} and reads its page. */
export class FuseContainerObject extends Cloudflare.DurableObject<FuseContainerObject>()(
  "FuseContainerObject",
  Effect.gen(function* () {
    const container = yield* FuseContainer;

    return Effect.gen(function* () {
      // Starting is idempotent: a no-op once the container is running.
      const start = container.start();
      const { fetch } = yield* container.getTcpPort(8080);

      return {
        read: () =>
          Effect.gen(function* () {
            yield* start;
            const response = yield* fetch(HttpClientRequest.get("http://container/"));
            return yield* response.text;
          }),
      };
    });
  }),
) {}
