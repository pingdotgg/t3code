import { useAtomValue } from "@effect/atom-react";
import {
  AuthFilesystemReadScope,
  type OrchestrationV2ThreadProjection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { formatFilePathPosition, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import {
  resolveMarkdownFileLinkTarget,
  resolveThreadFilePathCandidate,
} from "@t3tools/shared/markdownLinks";
import { isAbsolutePath, resolveWorkspaceFilePath } from "@t3tools/shared/path";
import { collectThreadFilePaths, createThreadFilePathIndex } from "@t3tools/shared/threadFilePaths";
import { Atom } from "effect/reactivity";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

import { projectEnvironment } from "../../state/projects";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/** Encode a literal selected path once before giving it back to markdown parsers. */
function fileLinkHref(target: string) {
  const position = splitFilePathPosition(target);
  return formatFilePathPosition({
    ...position,
    path: position.path
      .split(/([\\/])/)
      .map((part) =>
        part === "/" || part === "\\" || /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part),
      )
      .join(""),
  });
}

export function useThreadFileLinks(ref: ScopedThreadRef, cwd: string | null) {
  const visible = useAtomValue(environmentThreadDetails.quietVisibleTurnItemsAtom(ref));
  const paths = collectThreadFilePaths(
    visible.map(({ item }) => item),
    cwd,
  );
  const pathsKey = JSON.stringify(paths);
  const [indexed, setIndexed] = useState(() => ({
    key: pathsKey,
    index: createThreadFilePathIndex(paths),
  }));
  let index = indexed.index;
  if (indexed.key !== pathsKey) {
    index = createThreadFilePathIndex(paths);
    setIndexed({ key: pathsKey, index });
  }
  const canRead = useEnvironmentScope(ref.environmentId, AuthFilesystemReadScope);
  const connection = usePreparedConnection(ref.environmentId);
  const enabled = canRead && connection._tag === "Some";
  const { environmentId, threadId } = ref;
  useAtomValue(projectEnvironment.fileMetadataThread(ref));
  const checkpoints = useAtomValue(
    environmentThreadDetails.quietThreadAtom(ref),
    (thread) => thread?.projection.checkpoints,
  );
  const invalidate = useAtomCommand(projectEnvironment.invalidateFileMetadata, {
    reportFailure: false,
  });
  const previous = useRef<{
    environmentId: ScopedThreadRef["environmentId"];
    threadId: ScopedThreadRef["threadId"];
    cwd: string | null;
    checkpoints: OrchestrationV2ThreadProjection["checkpoints"];
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- invalidates retained file metadata for paths whose checkpoints changed
  useEffect(() => {
    if (!checkpoints) {
      previous.current = null;
      return;
    }
    const before = previous.current;
    previous.current = { environmentId, threadId, cwd, checkpoints };
    if (
      !before ||
      before.environmentId !== environmentId ||
      before.threadId !== threadId ||
      before.cwd !== cwd
    )
      return;
    const oldById = new Map(before.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
    const changed = new Set<string>();
    const addPath = (path: string) => {
      if (cwd !== null) changed.add(resolveWorkspaceFilePath(path, cwd));
      else if (isAbsolutePath(path)) changed.add(path);
    };
    for (const checkpoint of checkpoints) {
      const old = oldById.get(checkpoint.id);
      oldById.delete(checkpoint.id);
      if (old?.files === checkpoint.files && old?.status === checkpoint.status) continue;
      for (const file of checkpoint.files) addPath(file.path);
      for (const file of old?.files ?? []) addPath(file.path);
    }
    for (const checkpoint of oldById.values())
      for (const file of checkpoint.files) addPath(file.path);
    if (changed.size > 0) void invalidate({ environmentId, input: { paths: [...changed] } });
  }, [environmentId, threadId, cwd, checkpoints, invalidate]);
  // Rows re-render when this changes, so it keeps its identity across unrelated renders.
  return useMemo(
    () => ({ environmentId, threadId, cwd, enabled, index }),
    [environmentId, threadId, cwd, enabled, index],
  );
}

export const ThreadFileLinksContext = createContext<ReturnType<typeof useThreadFileLinks> | null>(
  null,
);

/** Maps each thread-evidenced href to its verified file; anything else keeps its href. */
export function useThreadFileBindings(urls: ReadonlyArray<string>) {
  const context = useContext(ThreadFileLinksContext);
  const bindingsAtom = Atom.make((get) => {
    const selected = new Map<string, string>();
    if (!context?.enabled) return selected;
    const { environmentId, threadId, cwd, index } = context;
    for (const href of urls) {
      const candidate = resolveThreadFilePathCandidate(href, cwd, index);
      if (!candidate) continue;
      const root = resolveMarkdownFileLinkTarget(href, cwd ?? undefined);
      const read = (path: string) =>
        get(
          projectEnvironment.fileMetadata({
            environmentId,
            input: { threadId, path: splitFilePathPosition(path).path },
          }),
        );
      const candidateResult = read(candidate);
      const rootResult = root === null ? null : read(root);
      if (
        candidateResult._tag === "Success" &&
        !candidateResult.waiting &&
        candidateResult.value?.kind === "file" &&
        (rootResult === null ||
          (rootResult._tag === "Success" && !rootResult.waiting && rootResult.value === null))
      ) {
        selected.set(href, fileLinkHref(candidate));
      }
    }
    return selected;
  });
  const selected = useAtomValue(bindingsAtom);
  const href = (url: string) => selected.get(url) ?? url;
  // Without a root, an unverified relative path has nowhere honest to open.
  const unverifiedRootless = (url: string) =>
    context?.cwd === null &&
    !selected.has(url) &&
    resolveThreadFilePathCandidate(url, null, context.index) !== null;
  return { href, unverifiedRootless };
}
