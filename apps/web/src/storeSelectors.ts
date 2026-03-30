import { type ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";
import { selectProjectById, selectThreadById, useStore } from "./store";
import { type Project, type Thread } from "./types";

export function useProjectById(projectId: Project["id"] | null | undefined): Project | undefined {
  const selector = useMemo(() => selectProjectById(projectId), [projectId]);
  return useStore(selector);
}

export function useThreadById(threadId: ThreadId | null | undefined): Thread | undefined {
  const selector = useMemo(() => selectThreadById(threadId), [threadId]);
  return useStore(selector);
}
