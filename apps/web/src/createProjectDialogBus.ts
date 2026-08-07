// Tiny event bus so any surface can open the create-project dialog without
// owning its React state. Mirrors `commandPaletteBus`.
//
// The dialog is mounted once at the route root rather than inside a sidebar:
// both sidebars and the empty-state hero open it, and it has to survive the
// sidebar unmounting underneath it.
import type { EnvironmentId } from "@t3tools/contracts";

const CREATE_PROJECT_DIALOG_OPEN_EVENT = "t3code:open-create-project-dialog";

export interface CreateProjectDialogDetail {
  readonly environmentId?: EnvironmentId;
  /** Pre-seed the first source folder, e.g. handing off from the palette's browse. */
  readonly initialFolderPath?: string;
}

export function openCreateProjectDialog(detail?: CreateProjectDialogDetail): void {
  window.dispatchEvent(
    new CustomEvent(CREATE_PROJECT_DIALOG_OPEN_EVENT, detail ? { detail } : undefined),
  );
}

export function onOpenCreateProjectDialog(
  listener: (detail: CreateProjectDialogDetail) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<CreateProjectDialogDetail>).detail ?? {});
  };
  window.addEventListener(CREATE_PROJECT_DIALOG_OPEN_EVENT, handler);
  return () => window.removeEventListener(CREATE_PROJECT_DIALOG_OPEN_EVENT, handler);
}
