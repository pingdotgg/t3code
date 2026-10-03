import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProjectReadFileResult,
  PullRequestDiffFileContentsResult,
  PullRequestRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useContext, useEffect, useMemo, useRef } from "react";

import { getProjectFileQueryAtom } from "~/components/files/projectFilesQueryState";
import { pullRequestEnvironment } from "~/state/pullRequests";
import {
  DEFAULT_TAB_WIDTH,
  editorConfigCandidates,
  editorConfigQueryPath,
  parseEditorConfig,
  resolveEditorConfigTabWidth,
} from "~/lib/editorConfig";

export interface PullRequestEditorConfigSource {
  readonly reference: PullRequestRef;
  readonly commit: string | null;
}

type ConfigFileQuery = Atom.Atom<
  AsyncResult.AsyncResult<ProjectReadFileResult | PullRequestDiffFileContentsResult, unknown>
>;

// The existing file query family caches reads by environment/workspace/path. Parsing is shared too,
// and stays reactive when a file query is refreshed, rather than retaining a second stale cache.
const parsedConfigAtom = Atom.family((fileAtom: ConfigFileQuery) =>
  Atom.make((get) => {
    const result = get(fileAtom);
    // A failure's previousSuccess is obsolete even when that failure is revalidating.
    // Successful SWR revalidation retains a Success result and keeps its width visible.
    const file = result._tag === "Failure" ? null : Option.getOrNull(AsyncResult.value(result));
    let config = null;
    if (file !== null && (!("truncated" in file) || !file.truncated)) {
      try {
        config = parseEditorConfig("newContents" in file ? file.newContents : file.contents);
      } catch {
        // Unsupported/malformed globs must not make a file or diff unavailable.
      }
    }
    // SWR keeps the last result while revalidating. It remains valid for display until replaced.
    return { config, waiting: result._tag === "Initial" };
  }),
);

export function useEditorConfigTabWidths(
  environmentId: EnvironmentId | null,
  cwd: string | null,
  paths: ReadonlyArray<string>,
  revision: string | null = null,
  refreshToken: string | number | null = null,
  pathRoot: string | null = cwd,
  pullRequest: PullRequestEditorConfigSource | null = null,
) {
  const registry = useContext(RegistryContext);
  const pathsKey = JSON.stringify(paths);
  const pullRequestKey = JSON.stringify(pullRequest);
  const scope = JSON.stringify([environmentId, cwd, pathRoot, pullRequestKey]);
  const widthsAtom = useMemo(
    () =>
      Atom.make((get) => {
        const widths = new Map<string, number>();
        const queries = new Set<ConfigFileQuery>();
        if (environmentId === null || cwd === null || pathRoot === null) return { widths, queries };
        const review: PullRequestEditorConfigSource | null = JSON.parse(pullRequestKey);
        const filePaths: string[] = JSON.parse(pathsKey);
        for (const path of filePaths) {
          const configs = [];
          let waiting = false;
          // Diff paths start at the repository root; reads retain the workspace's save-cache keys.
          // A PR snapshot ends at its repository root; never inherit local machine config.
          for (const candidate of editorConfigCandidates(review ? "/" : pathRoot, path)) {
            const configPath = candidate.configPath.slice(1);
            const query = review
              ? pullRequestEnvironment.diffFileContentsQuery({
                  environmentId,
                  input: {
                    ...review.reference,
                    ...(review.commit === null ? {} : { commit: review.commit }),
                    // Only read the new snapshot: a config need not exist on the old side.
                    changeType: "new",
                    oldPath: configPath,
                    newPath: configPath,
                  },
                })
              : getProjectFileQueryAtom(
                  environmentId,
                  cwd,
                  editorConfigQueryPath(cwd, candidate.configPath),
                );
            queries.add(query);
            const result = get(parsedConfigAtom(query));
            // Discover ancestors lazily so root=true does not request unrelated parent files.
            if (result.waiting) {
              waiting = true;
              break;
            }
            if (result.config === null) continue;
            configs.push({ config: result.config, relativePath: candidate.relativePath });
            if (result.config.root) break;
          }
          widths.set(path, waiting ? DEFAULT_TAB_WIDTH : resolveEditorConfigTabWidth(configs));
        }
        return { widths, queries };
      }).pipe(Atom.withLabel("web:editorconfig-tab-widths")),
    [cwd, environmentId, pathsKey, pathRoot, pullRequestKey],
  );
  const result = useAtomValue(widthsAtom);
  const previous = useRef({
    scope,
    revision,
    refreshToken,
    queries: new Set<ConfigFileQuery>(),
  });
  useEffect(() => {
    const prior = previous.current;
    const queries = prior.scope === scope ? prior.queries : new Set(result.queries);
    for (const query of result.queries) queries.add(query);
    previous.current = { scope, revision, refreshToken, queries };
    // The query family's SWR policy handles stale reads on mount. Existing view refreshes must also
    // refresh discovered ancestors, including files collapsed since the previous refresh.
    if (
      prior.scope === scope &&
      (prior.revision !== revision || prior.refreshToken !== refreshToken)
    ) {
      for (const query of queries) {
        registry.refresh(query);
      }
    }
  }, [registry, result.queries, revision, refreshToken, scope]);
  return result.widths;
}
