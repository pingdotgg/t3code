import {
  type AddProjectRemoteSource,
  type NewProjectPublishTarget,
} from "@t3tools/client-runtime/operations/projects";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { SourceControlProviderKind } from "@t3tools/contracts";
import { FolderGit2Icon, LinkIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { sourceControlIcon } from "~/sourceControlPresentation";
import { ITEM_ICON_CLASS } from "./CommandPalette.logic";
import { CommandPaletteTitleIcon } from "./CommandPaletteResults";
import { Button } from "./ui/button";
import { Kbd, KbdGroup } from "./ui/kbd";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function remoteProjectSourceIcon(
  source: AddProjectRemoteSource,
  className: string,
): ReactNode {
  if (source === "url") return <LinkIcon className={className} />;
  const Icon = sourceControlIcon(sourceControlClients.get(source));
  return <Icon className={className} />;
}

export function sourceControlHostIcon(
  definition: NewProjectPublishTarget["definition"],
  className: string,
): ReactNode {
  const Icon = sourceControlIcon(definition);
  return <Icon className={className} />;
}

/** The input's trailing submit button for the add-project, clone, and new-project flows. */
export function CommandPaletteSubmitButton(props: {
  readonly label: ReactNode;
  readonly shortcutLabel: string;
  readonly ariaLabel: string;
  readonly tooltip: ReactNode;
  readonly disabled: boolean;
  readonly onSubmit: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="xs"
            tabIndex={-1}
            className="absolute inset-e-2.5 top-1/2 -translate-y-1/2"
            aria-label={props.ariaLabel}
            disabled={props.disabled}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={props.onSubmit}
          />
        }
      >
        <span>{props.label}</span>
        <KbdGroup className="pointer-events-none -me-0.5">
          <Kbd>{props.shortcutLabel}</Kbd>
        </KbdGroup>
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Picks which host a new project publishes to. The row it sits in toggles on click, so the
 * picker keeps its clicks to itself. The row also cancels pointerdown to keep focus in the
 * input, which drops the mousedown Select opens on, so the picker opens on click instead.
 */
export function NewProjectPublishHostPicker(props: {
  readonly disabled: boolean;
  readonly targets: ReadonlyArray<NewProjectPublishTarget>;
  readonly value: SourceControlProviderKind;
  readonly onValueChange: (kind: SourceControlProviderKind) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="flex"
      onClick={(event) => {
        event.stopPropagation();
        // React bubbles the popup's clicks here through its portal; only the
        // trigger opens the picker.
        if (!event.currentTarget.contains(event.target as Node)) return;
        if (!props.disabled) setOpen(true);
      }}
    >
      <Select
        disabled={props.disabled}
        open={open}
        onOpenChange={setOpen}
        value={props.value}
        onValueChange={(kind) => {
          if (kind !== null) props.onValueChange(kind);
        }}
      >
        <SelectTrigger size="xs" variant="ghost" aria-label="Host for the new repository">
          <SelectValue>
            {(kind: SourceControlProviderKind) => sourceControlClients.get(kind).label}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {props.targets.map((target) => (
            <SelectItem key={target.definition.kind} hideIndicator value={target.definition.kind}>
              <span className="inline-flex items-center gap-1.5">
                {sourceControlHostIcon(target.definition, "size-3.5")}
                {target.definition.label}
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </span>
  );
}

export function NewProjectSummary(props: {
  readonly name: string;
  readonly pathPreview: string;
  readonly projectsRoot: string | null;
  readonly environmentLabel: string | null;
}) {
  return (
    <div className="p-2 pb-0">
      <div className="flex min-h-8 items-center gap-2 rounded-sm px-2 py-1.5">
        <CommandPaletteTitleIcon>
          <FolderGit2Icon className={ITEM_ICON_CLASS} />
        </CommandPaletteTitleIcon>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-foreground text-sm">
            {props.name.length > 0 ? props.name : "New project"}
          </span>
          <span className="truncate text-muted-foreground/85 text-xs">
            {props.name.length > 0
              ? `Creates ${props.pathPreview}`
              : `Goes in ${props.projectsRoot}`}
            {props.environmentLabel === null ? null : ` on ${props.environmentLabel}`}
          </span>
        </span>
      </div>
    </div>
  );
}

export function RemoteRepositorySummary(props: {
  readonly source: AddProjectRemoteSource;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="shrink-0 p-2 pb-0">
      <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Repository</div>
      <div className="flex min-h-8 items-center gap-2 rounded-sm px-2 py-1.5">
        <CommandPaletteTitleIcon>
          {remoteProjectSourceIcon(props.source, ITEM_ICON_CLASS)}
        </CommandPaletteTitleIcon>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-foreground text-sm">{props.title}</span>
          <span className="truncate text-muted-foreground/85 text-xs">{props.description}</span>
        </span>
      </div>
    </div>
  );
}
