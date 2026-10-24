import { useAtomValue } from "@effect/atom-react";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import type { ComposerPathSearchTarget } from "@t3tools/client-runtime/state/threads";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  resolveProviderSkillSourceKind,
  type ProviderSkillSourceKind,
} from "@t3tools/client-runtime/providerSkills";
import {
  AuthOrchestrationOperateScope,
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type ProjectEntry,
  type ProviderDriverKind,
  type PullRequestContextMetadata,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import {
  BlocksIcon,
  FolderIcon,
  FolderOpenIcon,
  InfoIcon,
  MessagesSquareIcon,
  PackageIcon,
  SettingsIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useLayoutEffect, useRef, useState } from "react";

import { type ComposerSlashCommand, type ComposerTriggerKind } from "../../composer-logic";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Command, CommandGroup, CommandItem, CommandList } from "../ui/command";
import { Kbd } from "../ui/kbd";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useRemoteOpenResolution } from "../../remoteOpen";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "../preview/fileExplorerLabel";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { ComposerBanner } from "./ComposerBanner";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";

export type ComposerCommandItem =
  | {
      id: string;
      type: "path";
      path: string;
      pathKind: ProjectEntry["kind"];
      searchTarget: ComposerPathSearchTarget;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "slash-command";
      command: ComposerSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "provider-slash-command";
      provider: ProviderDriverKind;
      command: ServerProviderSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "skill";
      provider: ProviderDriverKind;
      skill: ServerProviderSkill;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "pull-request";
      pullRequest: PullRequestContextMetadata;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "thread";
      thread: ScopedThreadRef;
      label: string;
      description: string;
    };

export const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
  listId: string;
  environmentId: EnvironmentId;
  items: ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  emptyStateText?: string;
  activeItemId: string | null;
  detailItem: ComposerCommandItem | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onShowDetail: (itemId: string) => void;
  onCloseDetail: () => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!props.activeItemId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-composer-item-id="${CSS.escape(props.activeItemId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [props.activeItemId]);

  return (
    <Command
      autoHighlight={false}
      mode="none"
      onItemHighlighted={(highlightedValue) => {
        props.onHighlightedItemChange(
          typeof highlightedValue === "string" ? highlightedValue : null,
        );
      }}
    >
      <ComposerBanner.Surface
        ref={listRef}
        className="flex min-h-0 w-full flex-col overflow-hidden pb-(--chat-composer-attachment-overlap) **:data-[slot=command-item]:rounded-lg **:data-[slot=scroll-area-scrollbar]:data-[orientation=vertical]:my-4"
        data-composer-command-drawer="true"
      >
        {props.detailItem ? (
          <ComposerCommandItemDetail
            item={props.detailItem}
            environmentId={props.environmentId}
            triggerKind={props.triggerKind}
            onClose={props.onCloseDetail}
          />
        ) : props.items.length > 0 ? (
          <CommandList
            id={props.listId}
            aria-label={props.triggerKind ? LISTBOX_LABEL_BY_TRIGGER[props.triggerKind] : undefined}
            className="max-h-72 min-h-0 scroll-pb-6"
          >
            <CommandGroup>
              {props.items.map((item) => (
                <ComposerCommandMenuItem
                  key={item.id}
                  optionId={composerSuggestionOptionId(props.listId, item.id)}
                  item={item}
                  triggerKind={props.triggerKind}
                  resolvedTheme={props.resolvedTheme}
                  isActive={props.activeItemId === item.id}
                  onHighlight={props.onHighlightedItemChange}
                  onShowDetail={props.onShowDetail}
                  onSelect={props.onSelect}
                />
              ))}
            </CommandGroup>
          </CommandList>
        ) : (
          <div className="px-5 pt-3.5 pb-7">
            <p className="text-secondary-label text-xs">
              {props.isLoading
                ? props.triggerKind === "skill"
                  ? "Searching workspace skills..."
                  : props.triggerKind === "pull-request"
                    ? "Finding pull request..."
                    : "Searching workspace files..."
                : (props.emptyStateText ??
                  (props.triggerKind === "skill"
                    ? "No skills found. Try / to browse provider commands."
                    : props.triggerKind === "path"
                      ? "No matching files or folders."
                      : "No matching command."))}
            </p>
          </div>
        )}
      </ComposerBanner.Surface>
    </Command>
  );
});

const DETAIL_BUTTON_TEXT_FADE = {
  maskImage: "linear-gradient(to left, transparent 1.5rem, black 2.75rem)",
};

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  optionId: string;
  item: ComposerCommandItem;
  triggerKind: ComposerTriggerKind | null;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
  onHighlight: (itemId: string | null) => void;
  onShowDetail: (itemId: string) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const descriptionRef = useRef<HTMLSpanElement>(null);
  const [isDescriptionTruncated, setIsDescriptionTruncated] = useState(false);
  useLayoutEffect(() => {
    const el = descriptionRef.current;
    if (!props.isActive || !el) return;
    const measure = () => setIsDescriptionTruncated(el.scrollWidth > el.clientWidth);
    measure();
    return observeResize(el, measure);
  }, [props.isActive]);
  const showDetailButton =
    props.isActive && (props.item.type === "skill" || isDescriptionTruncated);
  const skillSourceKind =
    props.item.type === "skill" ? resolveProviderSkillSourceKind(props.item.skill) : null;
  const isSlashSkill =
    props.triggerKind === "slash-command" && props.item.type === "skill" ? props.item.skill : null;
  const pullRequestPresentation =
    props.item.type === "pull-request" ? resolvePullRequestState(props.item.pullRequest) : null;

  return (
    <CommandItem
      render={<div id={props.optionId} />}
      aria-selected={props.isActive}
      value={props.item.id}
      data-composer-item-id={props.item.id}
      active={props.isActive}
      onMouseMove={() => {
        if (!props.isActive) props.onHighlight(props.item.id);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onSelect(props.item);
      }}
    >
      {props.item.type === "path" ? (
        <PierreEntryIcon
          pathValue={props.item.path}
          kind={props.item.pathKind}
          theme={props.resolvedTheme}
        />
      ) : null}
      {props.item.type === "thread" ? (
        <MessagesSquareIcon aria-hidden="true" className="size-4 shrink-0 text-secondary-label" />
      ) : null}
      {pullRequestPresentation ? (
        <pullRequestPresentation.Icon
          role="img"
          aria-label={pullRequestPresentation.label}
          className={cn("size-4 shrink-0", pullRequestPresentation.toneClassName)}
        />
      ) : null}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 max-w-[45%] shrink-0 truncate font-sans text-xs font-medium">
          {isSlashSkill ? (
            <>
              <span className="text-secondary-label">/skill:</span>
              {formatProviderSkillDisplayName(isSlashSkill)}
            </>
          ) : (
            props.item.label
          )}
        </span>
        <span className="relative flex min-w-0 flex-1">
          <span
            ref={descriptionRef}
            className="min-w-0 flex-1 truncate text-left text-secondary-label text-xs"
            style={showDetailButton ? DETAIL_BUTTON_TEXT_FADE : undefined}
          >
            {props.item.description}
          </span>
          {showDetailButton ? (
            <Button
              size="icon-micro"
              variant="ghost-muted"
              className="absolute end-0 top-1/2 -translate-y-1/2"
              aria-label={`Show details for ${props.item.label} (Right arrow)`}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={(event) => {
                event.stopPropagation();
                props.onShowDetail(props.item.id);
              }}
            >
              <InfoIcon />
            </Button>
          ) : null}
        </span>
        {skillSourceKind ? (
          <SkillSourceBadge
            kind={skillSourceKind}
            showSkillSuffix={props.triggerKind === "skill"}
          />
        ) : null}
      </span>
    </CommandItem>
  );
});

function ComposerCommandItemDetail(props: {
  item: ComposerCommandItem;
  environmentId: EnvironmentId;
  triggerKind: ComposerTriggerKind | null;
  onClose: () => void;
}) {
  const skill = props.item.type === "skill" ? props.item.skill : null;
  const skillSourceKind = skill ? resolveProviderSkillSourceKind(skill) : null;
  const description = skill?.description ?? props.item.description;
  const provider =
    props.item.type === "skill" || props.item.type === "provider-slash-command"
      ? props.item.provider
      : null;
  return (
    <div className="flex min-w-0 flex-col gap-2 px-4 pt-3 pb-7">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-sans text-sm font-medium">
          {skill && props.triggerKind === "slash-command" ? (
            <>
              <span className="text-secondary-label">/skill:</span>
              {formatProviderSkillDisplayName(skill)}
            </>
          ) : (
            props.item.label
          )}
        </span>
        {skillSourceKind ? (
          <SkillSourceBadge kind={skillSourceKind} showSkillSuffix={false} />
        ) : null}
        <ComposerBanner.Dismiss
          aria-label="Close details"
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={props.onClose}
        />
      </div>
      {description ? (
        <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-secondary-label text-xs">
          {description}
        </p>
      ) : null}
      {provider || skill ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {skill ? (
            <>
              <dt className="text-secondary-label">Name</dt>
              <dd className="truncate">{skill.name}</dd>
            </>
          ) : null}
          {provider ? (
            <>
              <dt className="text-secondary-label">Provider</dt>
              <dd className="truncate">{PROVIDER_DISPLAY_NAMES[provider] ?? provider}</dd>
            </>
          ) : null}
          {skill?.scope ? (
            <>
              <dt className="text-secondary-label">Scope</dt>
              <dd className="truncate">{skill.scope}</dd>
            </>
          ) : null}
          {skill ? (
            <>
              <dt className="text-secondary-label">Path</dt>
              <dd className="flex min-w-0 items-start gap-1">
                <span className="min-w-0 break-all">{skill.path}</span>
                <RevealSkillFileButton environmentId={props.environmentId} path={skill.path} />
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      <p className="text-secondary-label text-xs">
        <Kbd>Enter</Kbd> to use · <Kbd>←</Kbd> or <Kbd>Esc</Kbd> to go back
      </p>
    </div>
  );
}

function RevealSkillFileButton(props: { environmentId: EnvironmentId; path: string }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canOperateHost = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const remoteOpen = useRemoteOpenResolution(props.environmentId);
  const revealInFileManager = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  if (
    !config?.shellRevealInFileManager ||
    !config.availableEditors.includes("file-manager") ||
    !canOperateHost ||
    !remoteOpen.isResolved ||
    remoteOpen.state.mode !== "local-exec"
  ) {
    return null;
  }
  const label =
    config.shellRevealInFileManagerKind === undefined
      ? revealInFileExplorerLabelForOs(config.environment.platform.os)
      : revealInFileExplorerLabelForKind(config.shellRevealInFileManagerKind);
  return (
    <Button
      size="icon-micro"
      variant="ghost-muted"
      className="shrink-0"
      aria-label={label}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={async () => {
        const result = await revealInFileManager({
          environmentId: props.environmentId,
          input: { cwd: props.path, editor: "file-manager", reveal: true },
        });
        if (result._tag === "Success") return;
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to reveal skill file",
            description: error instanceof Error ? error.message : "Unknown error revealing file.",
          }),
        );
      }}
    >
      <FolderOpenIcon />
    </Button>
  );
}

export function composerSuggestionOptionId(listId: string, itemId: string): string {
  // JSON escapes lone UTF-16 surrogates before URI encoding without losing identity.
  return `${listId}-${encodeURIComponent(JSON.stringify(itemId))}`;
}

const LISTBOX_LABEL_BY_TRIGGER: Record<ComposerTriggerKind, string> = {
  path: "Files and folders",
  "pull-request": "Pull requests",
  "slash-command": "Commands",
  skill: "Skills",
};

const SKILL_SOURCE_ICON_BY_KIND: Record<ProviderSkillSourceKind, LucideIcon> = {
  app: BlocksIcon,
  repo: FolderIcon,
  project: FolderIcon,
  personal: UserRoundIcon,
  system: SettingsIcon,
  other: PackageIcon,
};

const SKILL_SOURCE_LABEL_BY_KIND: Record<ProviderSkillSourceKind, string> = {
  app: "App",
  repo: "Repo",
  project: "Project",
  personal: "Personal",
  system: "System",
  other: "Provider",
};

function SkillSourceBadge(props: { kind: ProviderSkillSourceKind; showSkillSuffix: boolean }) {
  const Icon = SKILL_SOURCE_ICON_BY_KIND[props.kind];
  return (
    <Badge className="ms-auto" variant="secondary">
      <Icon aria-hidden="true" className="text-current" />
      {SKILL_SOURCE_LABEL_BY_KIND[props.kind]}
      {props.showSkillSuffix ? " Skill" : null}
    </Badge>
  );
}
