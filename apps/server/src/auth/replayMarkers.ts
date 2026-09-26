import { DPOP_REPLAY_WINDOW_SECONDS } from "@t3tools/shared/dpop";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

import { CLOUD_REPLAY_MARKER_PREFIXES, CLOUD_REPLAY_WINDOW_SECONDS } from "../cloud/http.ts";
import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import { DPOP_REPLAY_MARKER_PREFIX } from "./dpop.ts";

const REPLAY_MARKER_PREFIXES = [DPOP_REPLAY_MARKER_PREFIX, ...CLOUD_REPLAY_MARKER_PREFIXES];

/**
 * How long a replay marker stays on disk. A marker only matters while its proof
 * can still be accepted, so this is twice the longest proof window. A longer
 * window moves it too. Markers are files, so a restart does not reset them.
 */
export const REPLAY_MARKER_MAX_AGE = Duration.seconds(
  2 * Math.max(DPOP_REPLAY_WINDOW_SECONDS, CLOUD_REPLAY_WINDOW_SECONDS),
);

/**
 * Deletes replay markers whose mtime is older than `REPLAY_MARKER_MAX_AGE`.
 * `ServerSecretStore` saves each secret as `<name>.bin`, so only
 * `<marker prefix>*.bin` names match. Other secrets and the `*.bin.<uuid>.tmp`
 * files that `set` writes are never touched.
 */
export const pruneExpiredReplayMarkers = Effect.fn("replayMarkers.pruneExpired")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { secretsDir } = yield* ServerConfig.ServerConfig;
  const cutoff = (yield* Clock.currentTimeMillis) - Duration.toMillis(REPLAY_MARKER_MAX_AGE);
  const markers = (yield* fileSystem.readDirectory(secretsDir)).filter(
    (name) =>
      name.endsWith(".bin") && REPLAY_MARKER_PREFIXES.some((prefix) => name.startsWith(prefix)),
  );
  // `partition` visits every marker, so one locked file does not stop the sweep.
  const [failures, removed] = yield* Effect.partition(markers, (name) => {
    const markerPath = path.join(secretsDir, name);
    return fileSystem.stat(markerPath).pipe(
      Effect.flatMap((info) =>
        Option.exists(info.mtime, (mtime) => mtime.getTime() < cutoff)
          ? fileSystem.remove(markerPath).pipe(Effect.as(true))
          : Effect.succeed(false),
      ),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
    );
  });
  yield* Effect.annotateCurrentSpan({
    "replay_markers.matched": markers.length,
    "replay_markers.removed": removed.filter(Boolean).length,
    "replay_markers.failed": failures.length,
  });
  if (failures.length > 0) {
    yield* Effect.logWarning("Failed to prune some replay markers", {
      failed: failures.length,
      cause: failures[0],
    });
  }
});

/** Prunes expired replay markers after server activation, then every 10 minutes. */
export const layer = Layer.effectDiscard(
  forkParked(
    pruneExpiredReplayMarkers().pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to prune expired replay markers", { cause }),
      ),
      Effect.repeat(Schedule.spaced(Duration.minutes(10))),
    ),
  ),
);
