/** @effect-diagnostics anyUnknownInErrorContext:off */

/**
 * INTERNAL — the "image source changed" trigger stream shared by the floci
 * dev providers that rebuild a Docker image on file change
 * ([ECS FlociTaskProvider](../ECS/FlociTaskProvider.ts),
 * [ECS FlociServiceProvider](../ECS/FlociServiceProvider.ts),
 * [Lambda FlociMicrovmImageProvider](../Lambda/FlociMicrovmImageProvider.ts)).
 * NOT exported from any service `index.ts`.
 */

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Bundle from "../../Bundle/Bundle.ts";
import { isInlineDockerfile } from "../../Docker/Dockerfile.ts";
import {
  imageSourceKind,
  makeBunBootstrap,
  makeImageSource,
  type BundledImageSource,
  type ImageSourceLike,
} from "../ECR/ImageSource.ts";

/**
 * A stream of "the image source changed" triggers for a props bag:
 *
 * - `main` — a `Bundle.watch` over the exact module graph the deploy
 *   bundles (rebuild successes are the trigger; rebuild errors are logged
 *   and swallowed);
 * - `context` — a debounced recursive `fs.watch` of the build context (and
 *   the Dockerfile's directory when it lives outside the context);
 * - `image` (registry ref) / inline-dockerfile-only — nothing local to
 *   watch: an empty stream.
 */
export const imageSourceTrigger = Effect.fn(function* (options: {
  /** Logical id, for log prefixes. */
  id: string;
  source: ImageSourceLike;
  isExternal: boolean | undefined;
}) {
  const { id, source } = options;
  const kind = imageSourceKind(source);

  if (kind === "main") {
    const imageSource = yield* makeImageSource;
    const plan = yield* imageSource.watchMain({
      source: source as BundledImageSource,
      isExternal: options.isExternal,
      bootstrap: makeBunBootstrap(source.handler ?? "default"),
    });
    return Bundle.watch(plan.inputOptions, plan.outputOptions, plan.extra).pipe(
      Stream.tap((event) =>
        event._tag === "Error"
          ? Effect.logWarning(
              `[alchemy dev] ${id}: rebuild failed: ${event.error.message}`,
            )
          : Effect.void,
      ),
      Stream.filter((event) => event._tag === "Success"),
      Stream.debounce("200 millis"),
      Stream.map(() => undefined),
    ) as Stream.Stream<void>;
  }

  if (kind === "context") {
    if (source.context === undefined) {
      // Inline-dockerfile-only builds have no local files to watch — the
      // content is a prop, and prop changes flow through the dev diff.
      return Stream.empty as Stream.Stream<void>;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const context = path.resolve(source.context);
    const streams: Stream.Stream<unknown, any>[] = [
      fs.watch(context, { recursive: true }),
    ];
    // A path Dockerfile living OUTSIDE the context dir is watched too.
    if (
      source.dockerfile !== undefined &&
      !isInlineDockerfile(source.dockerfile)
    ) {
      const dockerfile = path.resolve(source.dockerfile);
      if (!dockerfile.startsWith(`${context}/`)) {
        streams.push(fs.watch(path.dirname(dockerfile)));
      }
    }
    return Stream.mergeAll(streams, { concurrency: streams.length }).pipe(
      Stream.debounce("300 millis"),
      Stream.map(() => undefined),
      Stream.catchCause((cause) =>
        Stream.fromEffect(
          Effect.logWarning(`[alchemy dev] ${id}: context watch failed`, cause),
        ).pipe(Stream.drain),
      ),
    ) as Stream.Stream<void>;
  }

  // Registry `image` refs have nothing local to watch.
  return Stream.empty as Stream.Stream<void>;
});
