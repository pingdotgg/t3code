import type { DockerImagePublicationError } from "@alchemy.run/docker/RegistryError";
import type { TimeoutError } from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export const retryContainerPublication = <
  A,
  E extends DockerImagePublicationError | TimeoutError,
  R,
>(
  publication: Effect.Effect<A, E, R>,
) =>
  Effect.retry(publication, {
    while: (error) =>
      error._tag === "DockerRegistryBlobUnknown" ||
      error._tag === "DockerRegistryUnavailable" ||
      error._tag === "TimeoutError",
    schedule: Schedule.max([Schedule.spaced("3 seconds"), Schedule.recurs(5)]),
  });

/**
 * Publishes an image build with a deadline per attempt. A stalled BuildKit
 * export never fails on its own, so each attempt times out after three
 * minutes and is retried alongside transient registry errors.
 */
export const retryContainerBuild = <A, R>(
  build: Effect.Effect<A, DockerImagePublicationError, R>,
) => build.pipe(Effect.timeout("3 minutes"), retryContainerPublication);
