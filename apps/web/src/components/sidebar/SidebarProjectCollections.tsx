import { ChevronDownIcon, EllipsisIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { ProjectFavicon } from "../ProjectFavicon";
import type { ProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import {
  collectionMemberKey,
  collectionMemberMatchesRow,
  editProjectCollectionMembers,
  learnProjectCollectionAliases,
  mergeCollectionMemberAliases,
  PROJECT_COLLECTION_NAME_LIMIT,
  projectCollectionNameError,
  type ProjectCollection,
} from "../../projectCollections";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { cn, randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogPopup, DialogTitle, DialogFooter, DialogHeader } from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "../ui/menu";

export function SidebarProjectCollectionTabs(props: {
  readonly collections: readonly ProjectCollection[];
  readonly activeId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly onEdit: (id: string | null) => void;
}) {
  if (props.collections.length === 0) return null;
  const tabs = [{ id: null, name: "All" }, ...props.collections];
  return (
    <div className="flex min-w-0 items-center gap-1 pt-1">
      <div className="flex min-w-0 flex-1 overflow-x-auto" role="group" aria-label="Project groups">
        {tabs.map((group) => (
          <button
            type="button"
            key={group.id === null ? "all" : `collection:${group.id}`}
            aria-pressed={props.activeId === group.id}
            ref={
              props.activeId === group.id
                ? (node) => node?.scrollIntoView({ block: "nearest", inline: "nearest" })
                : undefined
            }
            onClick={() => props.onSelect(group.id)}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const index = tabs.findIndex((tab) => tab.id === group.id);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
              props.onSelect(tabs[next]!.id);
              const sibling = event.currentTarget.parentElement?.children.item(next);
              if (sibling instanceof HTMLElement) sibling.focus();
            }}
            className={cn(
              "shrink-0 cursor-pointer border-b-2 border-transparent px-2 py-1.5 text-xs text-sidebar-muted-foreground hover:text-sidebar-foreground focus-visible:outline-ring",
              props.activeId === group.id && "border-primary text-sidebar-foreground",
            )}
          >
            {group.name}
          </button>
        ))}
      </div>
      <Menu>
        <MenuTrigger
          render={<Button size="icon-sm" variant="ghost" aria-label="Manage project groups" />}
        >
          <EllipsisIcon className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {tabs.map((group) => (
            <MenuItem
              key={group.id === null ? "all" : `collection:${group.id}`}
              onClick={() => props.onSelect(group.id)}
            >
              {group.name}
              {props.activeId === group.id ? " ✓" : ""}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onClick={() => props.onEdit(null)}>
            <PlusIcon />
            New group
          </MenuItem>
          {props.activeId !== null ? (
            <MenuItem onClick={() => props.onEdit(props.activeId)}>Edit group</MenuItem>
          ) : null}
          {props.collections
            .filter((group) => group.id !== props.activeId)
            .map((group) => (
              <MenuItem key={`edit-${group.id}`} onClick={() => props.onEdit(group.id)}>
                Edit {group.name}
              </MenuItem>
            ))}
        </MenuPopup>
      </Menu>
    </div>
  );
}

export function ProjectCollectionDialog(props: {
  readonly collection: ProjectCollection | null;
  readonly catalog: readonly SidebarProjectSnapshot[];
  readonly settings: ProjectGroupingSettings;
  readonly onClose: () => void;
  readonly onSaved: (id: string) => void;
  readonly onDelete: (id: string) => void;
}) {
  const collections = useUiStateStore((state) => state.projectCollections);
  const save = useUiStateStore((state) => state.saveProjectCollection);
  const [name, setName] = useState(props.collection?.name ?? "");
  const [draftMembers, setMembers] = useState(props.collection?.members ?? []);
  const members = mergeCollectionMemberAliases(draftMembers, props.collection?.members ?? []);
  const selectedKeys = new Set(
    props.catalog
      .filter((row) =>
        members.some((member) => collectionMemberMatchesRow(member, row, props.settings)),
      )
      .map((row) => row.projectKey),
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const nameError = projectCollectionNameError(name, collections, props.collection?.id ?? null);
  const unavailable = [
    ...new Map(
      [...(props.collection?.members ?? []), ...members].map((member) => [
        collectionMemberKey(member),
        member,
      ]),
    ).values(),
  ].filter(
    (member) =>
      !props.catalog.some((row) => collectionMemberMatchesRow(member, row, props.settings)),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (nameError) return;
            const id = props.collection?.id ?? randomUUID();
            const collection = learnProjectCollectionAliases(
              [{ id, name, members }],
              props.catalog,
            )[0]!;
            const error = save(collection);
            if (error) {
              setSaveError(error);
              return;
            }
            props.onSaved(id);
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.collection ? "Edit group" : "New group"}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-6 py-4">
            <label className="flex flex-col gap-1.5 text-sm">
              Name
              <Input
                autoFocus
                value={name}
                maxLength={PROJECT_COLLECTION_NAME_LIMIT}
                onChange={(event) => {
                  setName(event.target.value);
                  setSaveError(null);
                }}
                aria-invalid={name.trim().length > 0 && nameError !== null}
              />
            </label>
            {(saveError ?? (name.trim() ? nameError : null)) ? (
              <p role="alert" className="text-xs text-destructive">
                {saveError ?? nameError}
              </p>
            ) : null}
            <div className="max-h-72 overflow-y-auto" role="group" aria-label="Group projects">
              {props.catalog.map((row) => (
                <label
                  key={row.projectKey}
                  className="flex cursor-pointer items-center gap-2 py-2 text-sm"
                >
                  <Checkbox
                    checked={selectedKeys.has(row.projectKey)}
                    onCheckedChange={(checked) => {
                      const next = new Set(selectedKeys);
                      if (checked) next.add(row.projectKey);
                      else next.delete(row.projectKey);
                      setMembers(
                        editProjectCollectionMembers({
                          members,
                          catalog: props.catalog,
                          settings: props.settings,
                          selectedProjectKeys: next,
                          removedMemberKeys: new Set(),
                        }),
                      );
                    }}
                  />
                  <span className="min-w-0 truncate">{row.displayName}</span>
                </label>
              ))}
              {unavailable.map((member) => {
                const key = collectionMemberKey(member);
                return (
                  <label key={key} className="flex cursor-pointer items-center gap-2 py-2 text-sm">
                    <Checkbox
                      checked={members.some((candidate) => collectionMemberKey(candidate) === key)}
                      onCheckedChange={(checked) =>
                        setMembers(
                          checked
                            ? [...members, member]
                            : members.filter((candidate) => collectionMemberKey(candidate) !== key),
                        )
                      }
                    />
                    <span className="min-w-0 truncate">
                      {member.kind === "scratch" ? "No project" : member.label}{" "}
                      <span className="text-muted-foreground">(Unavailable)</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
          <DialogFooter>
            {props.collection ? (
              <div className="mr-auto">
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => props.collection && props.onDelete(props.collection.id)}
                >
                  Delete group
                </Button>
              </div>
            ) : null}
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={nameError !== null}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function SidebarCollectionProjects(props: {
  readonly catalog: readonly SidebarProjectSnapshot[];
  readonly selectedKeys: readonly string[];
  readonly onNarrow: (key: string) => void;
  readonly onNewThread: (group: SidebarProjectSnapshot) => void;
  readonly onSettings: (group: SidebarProjectSnapshot) => void;
  readonly onContextMenu: (
    group: SidebarProjectSnapshot,
    position: { x: number; y: number },
  ) => void;
  readonly onEdit: (() => void) | null;
}) {
  const [expanded, setExpanded] = useLocalStorage(
    "sidebar-collection-projects-expanded",
    true,
    Schema.Boolean,
  );
  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-xs font-medium text-sidebar-muted-foreground"
      >
        <ChevronDownIcon className={cn("size-3", !expanded && "-rotate-90")} />
        Projects
      </button>
      {expanded
        ? props.catalog.map((project) => (
            <div
              key={project.projectKey}
              className="group flex items-center gap-1 rounded-md hover:bg-sidebar-row-hover"
              onContextMenu={(event) => {
                event.preventDefault();
                props.onContextMenu(project, { x: event.clientX, y: event.clientY });
              }}
            >
              <button
                type="button"
                aria-pressed={props.selectedKeys.includes(project.projectKey)}
                onClick={() => props.onNarrow(project.projectKey)}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-sm aria-pressed:bg-sidebar-row-hover"
              >
                <ProjectFavicon project={project} className="size-4 shrink-0" />
                <span className="truncate">{project.displayName}</span>
              </button>
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`New thread in ${project.displayName}`}
                onClick={() => props.onNewThread(project)}
              >
                <PlusIcon className="size-3.5" />
              </Button>
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`Settings for ${project.displayName}`}
                onClick={() => props.onSettings(project)}
              >
                <SettingsIcon className="size-3.5" />
              </Button>
            </div>
          ))
        : null}
      {props.onEdit && props.catalog.length > 0 ? (
        <Button variant="ghost" size="sm" onClick={props.onEdit}>
          Edit group
        </Button>
      ) : null}
    </div>
  );
}
