import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

interface LeaseRequest {
  readonly prefix: string;
  readonly granted: Deferred.Deferred<void>;
  held: boolean;
}

// Held and waiting leases in arrival order. A checkpoint restore cleans the
// whole checkout, so a lease conflicts with any lease on the same directory, an
// ancestor or a descendant, not only with an identical path string.
const requests: LeaseRequest[] = [];

const overlaps = (left: LeaseRequest, right: LeaseRequest) =>
  left.prefix.startsWith(right.prefix) || right.prefix.startsWith(left.prefix);

const grantWaiting = () => {
  requests.forEach((request, index) => {
    if (request.held) return;
    for (let earlier = 0; earlier < index; earlier++) {
      if (overlaps(requests[earlier]!, request)) return;
    }
    request.held = true;
    Deferred.doneUnsafe(request.granted, Effect.void);
  });
};

/**
 * Serializes work that changes a checkout's files: provider startup, checkpoint
 * restore, terminal startup, branch switches and worktree removal. Paths are
 * compared by real path, so symlink aliases share a lease. Not reentrant.
 */
export const withWorkspaceLease = Effect.fn("withWorkspaceLease")(function* <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // A removed worktree keys on its deepest existing ancestor, so its removal
  // and later recreation meet the same lease as an alias of the original path.
  const missingSegments: string[] = [];
  let candidate = path.resolve(cwd);
  let leasePath = candidate;
  while (true) {
    const real = yield* fileSystem.realPath(candidate).pipe(Effect.option);
    if (Option.isSome(real)) {
      leasePath = path.resolve(real.value, ...missingSegments);
      break;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    missingSegments.unshift(path.basename(candidate));
    candidate = parent;
  }
  return yield* Effect.uninterruptibleMask((restore) => {
    const prefix = leasePath.endsWith(path.sep) ? leasePath : `${leasePath}${path.sep}`;
    const request: LeaseRequest = {
      // Windows paths are case-insensitive and realPath keeps the caller's casing.
      prefix: path.sep === "\\" ? prefix.toLowerCase() : prefix,
      granted: Deferred.makeUnsafe<void>(),
      held: false,
    };
    requests.push(request);
    grantWaiting();
    return restore(Deferred.await(request.granted).pipe(Effect.andThen(effect))).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          requests.splice(requests.indexOf(request), 1);
          grantWaiting();
        }),
      ),
    );
  });
});
