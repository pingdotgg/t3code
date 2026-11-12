import {
  foldSearchQuery,
  PALETTE_SECONDARY_LIMIT,
  PALETTE_THREAD_LIMIT,
  rankSearchGroups,
  scoreSearchTerms,
  scoreThreadSearch,
  type SearchMatchHint,
  type SearchRange,
  type ThreadSearchSubject,
} from "@t3tools/shared/paletteSearch";
import type { CommandPaletteLinkedThreads } from "../commandPaletteBus";
import {
  addProjectRemoteSourceLabel,
  addProjectRemoteSourcePathHint,
  buildAddProjectRemoteSourceReadiness,
  type AddProjectRemoteSource,
  type AddProjectRemoteSourceReadiness,
} from "@t3tools/client-runtime/operations/projects";
import {
  type EnvironmentId,
  type ProjectId,
  type EnvironmentMachineKind,
  type FilesystemBrowseEntry,
  type KeybindingCommand,
  type SourceControlDiscoveryResult,
  type SourceControlRepositoryInfo,
  THREAD_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";
import { type ReactNode } from "react";
import { type Project, type SidebarThreadSummary, type Thread } from "../types";

export const RECENT_THREAD_LIMIT = 12;
export const ITEM_ICON_CLASS = "size-4 text-icon-muted";
export const ADDON_ICON_CLASS = "size-4";

export function buildLinkedThreadActionItems(
  input: CommandPaletteLinkedThreads & {
    query: string;
    icon: ReactNode;
    runThread: (thread: Pick<SidebarThreadSummary, "environmentId" | "id">) => Promise<void>;
  },
): CommandPaletteActionItem[] {
  return input.threads.map((thread) => ({
    kind: "action",
    value: `thread:${input.environmentId}:${thread.id}`,
    title: thread.title || "Untitled thread",
    description: thread.archivedAt === null ? "Linked thread" : "Archived thread",
    searchTerms: [input.query, thread.title],
    icon: input.icon,
    run: () => input.runThread({ environmentId: input.environmentId, id: thread.id }),
  }));
}

export function browseInputEndPaddingClass(input: {
  readonly willCreateProjectPath: boolean;
  readonly hasHighlightedBrowseItem: boolean;
}): string {
  if (input.willCreateProjectPath) {
    return "*:data-[slot=autocomplete-input]:pe-38!";
  }
  if (input.hasHighlightedBrowseItem) {
    return "*:data-[slot=autocomplete-input]:pe-30!";
  }
  return "*:data-[slot=autocomplete-input]:pe-24!";
}

export type SearchOverlayMode = "command" | "files" | "content";

export type CommandPaletteOpenIntent =
  | { readonly kind: "add-project" | "new-thread-in" | "change-theme" }
  | {
      readonly kind: "search";
      readonly query: string;
      readonly linkedThreads?: CommandPaletteLinkedThreads;
    };

export interface CommandPaletteUiState {
  readonly open: boolean;
  readonly mode: SearchOverlayMode;
  /** What the current palette session opened to; read once when the palette view mounts. */
  readonly openIntent: CommandPaletteOpenIntent | null;
  /** Bumped by every intent so an open palette starts over from the new one. */
  readonly session: number;
  readonly parentSearch?: CommandPaletteReturnContext;
  readonly restoredSearch?: CommandPaletteReturnContext;
}

export type CommandPaletteUiAction =
  | { readonly _tag: "SetOpen"; readonly open: boolean }
  | { readonly _tag: "ToggleMode"; readonly mode: SearchOverlayMode }
  | {
      readonly _tag: "OpenSearch";
      readonly query: string;
      readonly linkedThreads?: CommandPaletteLinkedThreads;
    }
  | { readonly _tag: "OpenAddProject" }
  | { readonly _tag: "OpenNewThreadIn" }
  | { readonly _tag: "OpenChangeTheme" }
  | {
      readonly _tag: "OpenChildSearch";
      readonly mode: "files" | "content";
      readonly context: CommandPaletteReturnContext;
    }
  | { readonly _tag: "BackToCommand" };

export type AddProjectEntry =
  | { readonly kind: "connect-environment" }
  | { readonly kind: "choose-environment" }
  | { readonly kind: "choose-source"; readonly environmentId: EnvironmentId };

export interface CommandPaletteThreadContentMatch {
  readonly source: "user" | "assistant";
  readonly snippet: string;
  readonly query: string;
}

export interface CommandPaletteItem {
  readonly kind: "action" | "submenu";
  readonly value: string;
  readonly searchTerms: ReadonlyArray<string>;
  readonly title: ReactNode;
  /** The title as plain text, for searching, when `title` is styled. */
  readonly searchTitle?: string;
  readonly description?: ReactNode;
  readonly threadContentMatch?: CommandPaletteThreadContentMatch;
  readonly timestamp?: string;
  /** Thread rows rank by this, with use history, instead of by `searchTerms`. */
  readonly threadSearch?: ThreadSearchSubject;
  /** Shown in place of the description when the match is not in the title. */
  readonly matchHint?: SearchMatchHint;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly titleLeadingContent?: ReactNode;
  readonly titleTrailingContent?: ReactNode;
  readonly shortcutCommand?: KeybindingCommand;
  readonly secondary?: boolean;
}

export interface CommandPaletteActionItem extends CommandPaletteItem {
  readonly kind: "action";
  readonly keepOpen?: boolean;
  readonly run: () => Promise<void>;
  /** A pin toggle on the row, also reached with the pin shortcut while the row is highlighted. */
  readonly pin?: CommandPaletteItemPin;
}

export interface CommandPaletteItemPin {
  readonly name: string;
  readonly pinned: boolean;
  readonly toggle: () => void;
}

export interface CommandPaletteSubmenuItem extends CommandPaletteItem {
  readonly kind: "submenu";
  readonly addonIcon: ReactNode;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly initialQuery?: string;
}

export interface CommandPaletteGroup {
  readonly value: string;
  readonly label: string;
  readonly items: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
}

export interface CommandPaletteView {
  readonly addonIcon: ReactNode;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly initialQuery?: string;
}

// Child search unmounts the palette; retain search data without its view closures.
export interface CommandPaletteReturnContext {
  readonly query: string;
  readonly linkedThreadSearch: Extract<CommandPaletteOpenIntent, { kind: "search" }> | null;
}

export interface CommandPaletteSearchState {
  readonly query: string;
  readonly views: ReadonlyArray<{
    readonly view: CommandPaletteView;
    readonly parentQuery: string;
  }>;
}

export type CommandPaletteRow =
  | {
      readonly kind: "label";
      readonly key: string;
      readonly label: string;
      readonly first: boolean;
    }
  | {
      readonly kind: "item";
      readonly key: string;
      readonly item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
      readonly itemIndex: number | null;
    };

export type CommandPaletteMode = "root" | "root-browse" | "submenu" | "submenu-browse";

export type CommandPaletteProject = Project & { readonly displayName: string };

export type BuildThreadActionItemsThread = Pick<
  SidebarThreadSummary,
  | "archivedAt"
  | "branch"
  | "createdAt"
  | "environmentId"
  | "id"
  | "lineage"
  | "modelSelection"
  | "projectId"
  | "runtime"
  | "title"
  | "worktreePath"
> &
  Partial<
    Pick<
      SidebarThreadSummary,
      "pullRequests" | "linkedPullRequest" | "branchPullRequest" | "opens" | "latestUserMessageAt"
    >
  > & {
    updatedAt: string;
  };

export type PaletteItem = CommandPaletteActionItem | CommandPaletteSubmenuItem;

export interface AddProjectEnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
  readonly isPrimary: boolean;
  readonly isConnected: boolean;
  readonly status: string;
}

export type AddProjectCloneFlow =
  | {
      readonly step: "repository";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
    }
  | {
      readonly step: "confirm";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
      readonly repositoryInput: string;
      readonly repository: SourceControlRepositoryInfo | null;
      readonly remoteUrl: string;
    };

