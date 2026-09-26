import type { ThreadDetailsSectionsSetting } from "@t3tools/contracts";

export const THREAD_DETAILS_SECTION_IDS = [
  "workspace",
  "version-control",
  "automations",
  "relationships",
] as const;
export type ThreadDetailsSectionId = (typeof THREAD_DETAILS_SECTION_IDS)[number];

export type ThreadDetailsVisibilityMode = "always" | "relevant" | "hidden";

export interface ThreadDetailsSectionItem {
  readonly id: string;
  readonly label: string;
}

export interface ThreadDetailsSectionDefinition {
  readonly id: ThreadDetailsSectionId;
  readonly title: string;
  readonly relevantDescription: string;
  readonly alwaysDescription: string;
  readonly emptyLabel: string;
  readonly items: ReadonlyArray<ThreadDetailsSectionItem>;
}

export const THREAD_DETAILS_SECTION_BY_ID: Record<
  ThreadDetailsSectionId,
  ThreadDetailsSectionDefinition
> = {
  workspace: {
    id: "workspace",
    title: "Workspace",
    relevantDescription: "Shows available workspace controls.",
    alwaysDescription: "Keeps this section visible when empty.",
    emptyLabel: "No workspace controls available.",
    items: [
      { id: "environment", label: "Environment" },
      { id: "branch", label: "Branch / worktree" },
      { id: "openIn", label: "Open in editor" },
      { id: "scripts", label: "Project scripts" },
    ],
  },
  "version-control": {
    id: "version-control",
    title: "Version Control",
    relevantDescription: "Shows when this workspace uses Git.",
    alwaysDescription: "Keeps this section visible when empty.",
    emptyLabel: "Version control unavailable.",
    items: [
      { id: "branch", label: "Branch" },
      { id: "gitActions", label: "Git actions" },
    ],
  },
  automations: {
    id: "automations",
    title: "Automations",
    relevantDescription: "Shows when automations are available for this thread.",
    alwaysDescription: "Keeps this section visible when empty.",
    emptyLabel: "No automations.",
    items: [],
  },
  relationships: {
    id: "relationships",
    title: "Lineage",
    relevantDescription: "Shows when this thread has related threads.",
    alwaysDescription: "Keeps this section visible when empty.",
    emptyLabel: "No related threads.",
    items: [],
  },
};

export const THREAD_DETAILS_SECTIONS: ReadonlyArray<ThreadDetailsSectionDefinition> = Object.values(
  THREAD_DETAILS_SECTION_BY_ID,
);

export function threadDetailsSectionMode(
  overrides: ThreadDetailsSectionsSetting,
  sectionId: ThreadDetailsSectionId,
): ThreadDetailsVisibilityMode {
  return overrides.sections[sectionId]?.visibility ?? "relevant";
}

export function threadDetailsItemVisible(
  overrides: ThreadDetailsSectionsSetting,
  sectionId: ThreadDetailsSectionId,
  itemId: string,
): boolean {
  return overrides.sections[sectionId]?.items?.[itemId] !== false;
}

/**
 * Turns a visibility mode plus the app's own availability and content state
 * into a render decision. "relevant" is today's behavior: the section appears
 * only when it has content. "always" keeps the heading and shows a terse empty
 * state instead; it never bypasses hard availability gates such as drafts.
 */
export function resolveThreadDetailsSectionRender(input: {
  readonly mode: ThreadDetailsVisibilityMode;
  readonly available: boolean;
  readonly hasContent: boolean;
}): { readonly render: boolean; readonly showEmptyState: boolean } {
  if (input.mode === "hidden" || !input.available) {
    return { render: false, showEmptyState: false };
  }
  if (input.mode === "always") {
    return { render: true, showEmptyState: !input.hasContent };
  }
  return { render: input.hasContent, showEmptyState: false };
}

export function isEmptyThreadDetailsSections(overrides: ThreadDetailsSectionsSetting): boolean {
  return Object.keys(overrides.sections).length === 0;
}

export function setThreadDetailsSectionMode(
  sections: ThreadDetailsSectionsSetting,
  sectionId: ThreadDetailsSectionId,
  mode: ThreadDetailsVisibilityMode,
): ThreadDetailsSectionsSetting {
  return {
    sections: {
      ...sections.sections,
      [sectionId]: { ...sections.sections[sectionId], visibility: mode },
    },
  };
}

/**
 * Applies a drop in the customize editor. Dropping on the tray hides the
 * section; dropping a hidden section on the panel restores the mode it had
 * before it was hidden, or Auto. Returns null when the drop changes nothing.
 */
export function dropThreadDetailsSection(input: {
  readonly sections: ThreadDetailsSectionsSetting;
  readonly sectionId: ThreadDetailsSectionId;
  readonly zone: "panel" | "tray";
  readonly previousMode: "always" | "relevant" | undefined;
}): ThreadDetailsSectionsSetting | null {
  const current = threadDetailsSectionMode(input.sections, input.sectionId);
  if (input.zone === "tray") {
    return current === "hidden"
      ? null
      : setThreadDetailsSectionMode(input.sections, input.sectionId, "hidden");
  }
  return current === "hidden"
    ? setThreadDetailsSectionMode(input.sections, input.sectionId, input.previousMode ?? "relevant")
    : null;
}
