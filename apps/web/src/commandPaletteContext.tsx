import { createContext, use, type ReactNode } from "react";

const OpenAddProjectCommandPaletteContext = createContext<(() => void) | null>(null);

export function OpenAddProjectCommandPaletteProvider(props: {
  readonly children: ReactNode;
  readonly openAddProject: () => void;
}) {
  return (
    <OpenAddProjectCommandPaletteContext value={props.openAddProject}>
      {props.children}
    </OpenAddProjectCommandPaletteContext>
  );
}

export function useOpenAddProjectCommandPalette(): () => void {
  const openAddProject = use(OpenAddProjectCommandPaletteContext);
  if (!openAddProject) {
    throw new Error("Command palette actions must be used inside CommandPalette");
  }
  return openAddProject;
}

/** Read at event time so the chat tree does not subscribe to transient dialog state. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" &&
    document.querySelector("[data-command-palette], [data-project-search]") !== null
  );
}
