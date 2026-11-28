import type { ReviewParsedDiff, ReviewRenderableFile } from "../review/reviewModel";
import { createNativeReviewDiffSourceLoader } from "./nativeReviewDiffSource";
import type { NativeReviewDiffFile, NativeReviewDiffSource } from "./nativeReviewDiffTypes";

type SourceRequest = () => Promise<NativeReviewDiffSource>;

interface SourceSnapshot {
  readonly firstFile: ReviewRenderableFile;
  readonly scope: string;
  readonly load: ReturnType<typeof createNativeReviewDiffSourceLoader<SourceRequest>>;
  readonly requests: WeakMap<
    ReviewRenderableFile,
    { readonly completePatch: boolean; readonly request: SourceRequest }
  >;
}

export function createDiffHighlightCache(): { snapshot?: SourceSnapshot } {
  return {};
}

/**
 * Gives each file a loader for its whole old and new contents, so a hunk that starts inside a
 * docstring or an embedded script block is tokenized with the lines above it. `scope` names
 * everything `fetchFile` reads; a new scope or a new first file starts a new snapshot.
 */
export function withDiffSourceLoaders(
  scope: string,
  parsed: ReviewParsedDiff,
  files: ReadonlyArray<NativeReviewDiffFile>,
  fetchFile: (file: ReviewRenderableFile) => Promise<NativeReviewDiffSource>,
  cache = createDiffHighlightCache(),
): ReadonlyArray<NativeReviewDiffFile> {
  if (parsed.kind !== "files" || !parsed.files[0]) return files;
  const byId = new Map(parsed.files.map((file) => [file.id, file]));
  const firstFile = parsed.files[0];
  // Appended pages share one loader budget; a new first file starts a new snapshot.
  let snapshot = cache.snapshot;
  if (!snapshot || snapshot.firstFile !== firstFile || snapshot.scope !== scope) {
    snapshot = {
      firstFile,
      scope,
      load: createNativeReviewDiffSourceLoader<SourceRequest>((request) => request()),
      requests: new WeakMap(),
    };
    cache.snapshot = snapshot;
  }
  const { load, requests } = snapshot;
  return files.map((nativeFile) => {
    const file = byId.get(nativeFile.id);
    if (!file) return nativeFile;
    const completePatch = parsed.notice === null && !!file.completePatchSource;
    const cached = requests.get(file);
    if (cached?.completePatch === completePatch)
      return { ...nativeFile, loadContents: (signal) => load(cached.request, signal) };
    const request: SourceRequest = async () =>
      completePatch && file.completePatchSource ? file.completePatchSource() : fetchFile(file);
    requests.set(file, { completePatch, request });
    return { ...nativeFile, loadContents: (signal) => load(request, signal) };
  });
}
