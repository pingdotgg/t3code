import { getUrlDiagnostics } from "@t3tools/shared/urlDiagnostics";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

const WORKSPACE_IMAGE_IDLE_TTL_MS = 30 * 60_000;

type ImagePrefetch = (uri: string) => Promise<boolean>;

class WorkspaceImageCacheKey extends Data.Class<{ readonly uri: string }> {}

export class WorkspaceImagePrefetchUnavailableError extends Schema.TaggedErrorClass<WorkspaceImagePrefetchUnavailableError>()(
  "WorkspaceImagePrefetchUnavailableError",
  {
    uriHash: Schema.Number,
    uriLength: Schema.Number,
    uriProtocol: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return `Image prefetch did not cache the requested ${this.uriProtocol ?? "unknown-protocol"} resource (URI length ${this.uriLength}).`;
  }
}

export class WorkspaceImagePrefetchFailedError extends Schema.TaggedErrorClass<WorkspaceImagePrefetchFailedError>()(
  "WorkspaceImagePrefetchFailedError",
  {
    uriHash: Schema.Number,
    uriLength: Schema.Number,
    uriProtocol: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Image prefetch failed for the requested ${this.uriProtocol ?? "unknown-protocol"} resource (URI length ${this.uriLength}).`;
  }
}

export const WorkspaceImagePrefetchError = Schema.Union([
  WorkspaceImagePrefetchUnavailableError,
  WorkspaceImagePrefetchFailedError,
]);
export type WorkspaceImagePrefetchError = typeof WorkspaceImagePrefetchError.Type;

async function prefetchWithNativeImage(uri: string): Promise<boolean> {
  const { Image } = await import("react-native");
  return Image.prefetch(uri);
}

function describeWorkspaceImageUri(uri: string) {
  const diagnostics = getUrlDiagnostics(uri);
  return {
    uriHash: Hash.hash(uri),
    uriLength: diagnostics.inputLength,
    uriProtocol: diagnostics.protocol ?? null,
  };
}

export function createWorkspaceFileImageAtomFamily(options?: {
  readonly idleTtlMs?: number;
  readonly prefetch?: ImagePrefetch;
}) {
  const idleTtlMs = options?.idleTtlMs ?? WORKSPACE_IMAGE_IDLE_TTL_MS;
  const prefetch = options?.prefetch ?? prefetchWithNativeImage;
  const family = Atom.family((key: WorkspaceImageCacheKey) => {
    const uriContext = describeWorkspaceImageUri(key.uri);
    return Atom.make(
      Effect.gen(function* () {
        const cached = yield* Effect.tryPromise({
          try: () => prefetch(key.uri),
          catch: (cause) => new WorkspaceImagePrefetchFailedError({ ...uriContext, cause }),
        });
        if (!cached) {
          return yield* new WorkspaceImagePrefetchUnavailableError(uriContext);
        }
        return key.uri;
      }),
    ).pipe(
      Atom.setIdleTTL(idleTtlMs),
      Atom.withLabel(`mobile:workspace-image:${uriContext.uriHash.toString(36)}`),
    );
  });

  return (uri: string) => family(new WorkspaceImageCacheKey({ uri }));
}

export const workspaceFileImageAtom = createWorkspaceFileImageAtomFamily();
