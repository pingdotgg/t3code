import type { FileDiffMetadata } from "@pierre/diffs";
import { threadRelativeFilePath } from "@t3tools/client-runtime/state/thread-repositories";
import type {
  EnvironmentId,
  ReviewDiffPreviewInput,
  WorkspaceListRepositoriesResult,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { DiffPanelRepository } from "~/diffPanelStore";
import { reviewEnvironment } from "~/state/review";
import { revisionedQuery } from "~/state/revisionedQuery";

const placedFiles = new WeakMap<FileDiffMetadata, Map<string, FileDiffMetadata>>();

/**
 * A repo's diff files with paths from the thread's cwd, so All repos lists every repo in one
 * view and every path opens against the thread's cwd. Placed files keep their identity.
 */
export function placeRepositoryFiles(
  files: ReadonlyArray<FileDiffMetadata>,
  relativePath: string,
): ReadonlyArray<FileDiffMetadata> {
  if (relativePath.length === 0) return files;
  return files.map((file) => {
    let byPrefix = placedFiles.get(file);
    if (byPrefix === undefined) {
      byPrefix = new Map();
      placedFiles.set(file, byPrefix);
    }
    let placed = byPrefix.get(relativePath);
    if (placed === undefined) {
      placed = {
        ...file,
        name: threadRelativeFilePath(relativePath, file.name),
        ...(file.prevName === undefined
          ? {}
          : { prevName: threadRelativeFilePath(relativePath, file.prevName) }),
        // A prefix, so the `:pending` suffix the review view checks stays at the end.
        ...(file.cacheKey === undefined
          ? {}
          : { cacheKey: `${relativePath}\u0000${file.cacheKey}` }),
      };
      byPrefix.set(relativePath, placed);
    }
    return placed;
  });
}

/** The repos the diff filter offers: the thread's repos, then a repo opened from outside them. */
export function diffPanelRepositoryOptions(
  workspace: WorkspaceListRepositoriesResult | null,
  selected: DiffPanelRepository | undefined,
  /** The thread's own Git checkout, offered when only a repo opened from outside is listed. */
  home: { readonly name: string; readonly cwd: string } | null = null,
): ReadonlyArray<DiffPanelRepository & { readonly relativePath: string | null }> {
  // A tracked folder gone from disk has nothing to diff; project settings offer Locate.
  const present = workspace?.repositories.filter((repository) => !repository.missing) ?? [];
  const options = present.map((repository) => ({
    key: repository.kind === "home" ? "home" : repository.originalPath,
    name: repository.name,
    cwd: repository.cwd,
    relativePath: repository.relativePath,
  }));
  if (selected === undefined || options.some((option) => option.cwd === selected.cwd))
    return options;
  // A single-repo thread lists no repos; keep a way back to its own checkout.
  const withHome =
    options.length === 0 && home !== null
      ? [{ key: "home", name: home.name, cwd: home.cwd, relativePath: "" }]
      : options;
  return withHome.some((option) => option.cwd === selected.cwd)
    ? withHome
    : [...withHome, { ...selected, relativePath: null }];
}

type DiffPreviewQuery = ReturnType<typeof reviewEnvironment.diffPreview>;
type DiffPreviewResult = DiffPreviewQuery extends Atom.Atom<infer A> ? A : never;

const NO_REPOSITORY_DIFF_PREVIEWS = Atom.make<ReadonlyArray<DiffPreviewResult>>([]);

const repositoryDiffPreviewsFamily = Atom.family((key: string) => {
  const target = JSON.parse(key) as {
    readonly environmentId: EnvironmentId;
    readonly inputs: ReadonlyArray<ReviewDiffPreviewInput>;
    readonly revision?: string | null;
  };
  const queries = target.inputs.map((input) =>
    revisionedQuery(
      reviewEnvironment.diffPreview({ environmentId: target.environmentId, input }),
      target.revision,
    ),
  );
  return Atom.readable(
    (get): ReadonlyArray<DiffPreviewResult> => queries.map((query) => get(query)),
    (refresh) => {
      for (const query of queries) refresh(query);
    },
  );
});

/** Every repo's diff preview for All repos, in input order and refreshed together. */
export function repositoryDiffPreviewsAtom(
  target: {
    readonly environmentId: EnvironmentId;
    readonly inputs: ReadonlyArray<ReviewDiffPreviewInput>;
    /** The workspace revision; a new one refetches, `undefined` reads without refetching. */
    readonly revision: string | null | undefined;
  } | null,
): Atom.Atom<ReadonlyArray<DiffPreviewResult>> {
  return target === null
    ? NO_REPOSITORY_DIFF_PREVIEWS
    : repositoryDiffPreviewsFamily(JSON.stringify(target));
}
