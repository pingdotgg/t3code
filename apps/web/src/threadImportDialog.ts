import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

const THREAD_IMPORT_DIALOG_EVENT = "t3code:open-thread-import-dialog";

export interface ThreadImportDialogTarget {
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
}

export function openThreadImportDialog(target?: ThreadImportDialogTarget): void {
  window.dispatchEvent(
    new CustomEvent<ThreadImportDialogTarget>(THREAD_IMPORT_DIALOG_EVENT, {
      detail: target ?? {},
    }),
  );
}

export function onOpenThreadImportDialog(
  listener: (target: ThreadImportDialogTarget) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<ThreadImportDialogTarget>).detail ?? {});
  };
  window.addEventListener(THREAD_IMPORT_DIALOG_EVENT, handler);
  return () => window.removeEventListener(THREAD_IMPORT_DIALOG_EVENT, handler);
}
