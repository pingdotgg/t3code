import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import * as Stream from "effect/Stream";

const VCS_STATUS_WATCH_IGNORED_ROOTS = new Set([".git"]);

export function watchEventPath(path: Path.Path, rawCwd: string, eventPath: string): string | null {
  const relativePath = path.isAbsolute(eventPath) ? path.relative(rawCwd, eventPath) : eventPath;
  if (!relativePath || relativePath === ".") return null;
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
  return relativePath.split(path.sep).join("/");
}

export function shouldIgnoreWatchEventPath(relativePath: string): boolean {
  const [rootSegment] = relativePath.split("/");
  return rootSegment ? VCS_STATUS_WATCH_IGNORED_ROOTS.has(rootSegment) : false;
}

export function localWatchRefreshSignals<E, R, R2>(
  relativePaths: Stream.Stream<string, E, R>,
  shouldRefreshForPaths: (relativePaths: readonly string[]) => Effect.Effect<boolean, never, R2>,
  debounceDuration: Duration.Duration = Duration.millis(150),
): Stream.Stream<void, E, R | R2> {
  return relativePaths.pipe(
    Stream.filter((relativePath) => !shouldIgnoreWatchEventPath(relativePath)),
    Stream.groupedWithin(512, debounceDuration),
    Stream.map((paths) => [...new Set(paths)]),
    Stream.filter((paths) => paths.length > 0),
    Stream.filterEffect(shouldRefreshForPaths),
    Stream.map(() => undefined),
  );
}
