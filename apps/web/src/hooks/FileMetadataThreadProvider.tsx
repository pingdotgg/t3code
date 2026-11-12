import { useAtomValue } from "@effect/atom-react";
import type { OrchestrationV2ThreadProjection, ScopedThreadRef } from "@t3tools/contracts";
import { resolveWorkspaceFilePath } from "@t3tools/shared/path";
import { Atom } from "effect/reactivity";
import { createContext, useEffect, useRef, type ReactNode } from "react";

import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";

export const FileMetadataThreadContext = createContext<ScopedThreadRef | null>(null);
const EMPTY_RETENTION = Atom.make(undefined);

/** Keeps fetched metadata across virtualized message-row unmounts. */
export function FileMetadataThreadProvider(props: {
  threadRef: ScopedThreadRef | null;
  cwd: string | undefined;
  checkpoints: OrchestrationV2ThreadProjection["checkpoints"] | undefined;
  children?: ReactNode;
}) {
  const { threadRef, cwd, checkpoints, children } = props;
  useAtomValue(threadRef ? projectEnvironment.fileMetadataThread(threadRef) : EMPTY_RETENTION);
  const invalidate = useAtomCommand(projectEnvironment.invalidateFileMetadata, {
    reportFailure: false,
  });
  const previous = useRef<{
    environmentId: ScopedThreadRef["environmentId"];
    threadId: ScopedThreadRef["threadId"];
    cwd: string;
    checkpoints: OrchestrationV2ThreadProjection["checkpoints"];
  } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- invalidates the server file metadata cache for files whose checkpoints changed
  useEffect(() => {
    if (!threadRef || !cwd || !checkpoints) {
      previous.current = null;
      return;
    }
    const before = previous.current;
    previous.current = { ...threadRef, cwd, checkpoints };
    if (
      !before ||
      before.environmentId !== threadRef.environmentId ||
      before.threadId !== threadRef.threadId ||
      before.cwd !== cwd
    )
      return;
    const oldById = new Map(before.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
    const paths = new Set<string>();
    for (const checkpoint of checkpoints) {
      const old = oldById.get(checkpoint.id);
      oldById.delete(checkpoint.id);
      if (old?.files === checkpoint.files && old?.status === checkpoint.status) continue;
      for (const file of checkpoint.files) paths.add(resolveWorkspaceFilePath(file.path, cwd));
      for (const file of old?.files ?? []) paths.add(resolveWorkspaceFilePath(file.path, cwd));
    }
    for (const checkpoint of oldById.values())
      for (const file of checkpoint.files) paths.add(resolveWorkspaceFilePath(file.path, cwd));
    if (paths.size > 0)
      void invalidate({ environmentId: threadRef.environmentId, input: { paths: [...paths] } });
  }, [threadRef, cwd, checkpoints, invalidate]);

  return <FileMetadataThreadContext value={threadRef}>{children}</FileMetadataThreadContext>;
}
