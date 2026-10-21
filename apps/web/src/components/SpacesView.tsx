import { useState, type CSSProperties, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  ArrowUpRightIcon,
  GripVerticalIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  assignProjectSpace,
  removeSpace,
  resolveProjectSpace,
} from "@t3tools/client-runtime/state/spaces";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { Space } from "@t3tools/contracts/settings";
import { useClientSettings } from "../hooks/useSettings";
import { reportSpaceError, updateSpaces, useSelectSpace } from "../hooks/useSpaces";
import { useTheme } from "../hooks/useTheme";
import { useCustomThemes } from "../hooks/useCustomThemes";
import { useEnvironmentThemeDefinitions } from "../hooks/useEnvironmentTheme";
import { SpaceEditorDialog, spacePreviewColors } from "./Spaces";
import { useProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { cn } from "../lib/utils";
import { isElectron } from "../env";
import { ProjectFavicon } from "./ProjectFavicon";
import { WorkspacePageHeader } from "./WorkspacePageHeader";
import { SidebarInset } from "./ui/sidebar";
import { Button } from "./ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const columnKey = (spaceId: string | null) => `space:${spaceId ?? "unassigned"}`;
const projectKey = (project: EnvironmentProject) =>
  scopedProjectKey(scopeProjectRef(project.environmentId, project.id));

function ProjectSummary({
  project,
  detail,
}: {
  project: EnvironmentProject;
  detail?: string | undefined;
}) {
  return (
    <>
      <ProjectFavicon project={project} className="size-5 shrink-0" />
      <Tooltip>
        <TooltipTrigger render={<div className="min-w-0 flex-1" />}>
          <p className="truncate text-sm font-medium">{project.title}</p>
          {detail ? <p className="truncate text-xs text-muted-foreground">{detail}</p> : null}
        </TooltipTrigger>
        <TooltipPopup>{project.workspaceRoot}</TooltipPopup>
      </Tooltip>
    </>
  );
}

function SpaceProject({
  project,
  spaceId,
  detail,
}: {
  project: EnvironmentProject;
  spaceId: string | null;
  detail: string | undefined;
}) {
  const spaces = useClientSettings((settings) => settings.spaces);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: projectKey(project),
  });
  const move = (nextSpaceId: string | null) => {
    void updateSpaces((state) =>
      assignProjectSpace(state, scopeProjectRef(project.environmentId, project.id), nextSpaceId),
    ).catch(reportSpaceError);
  };
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      // The whole card drags with a mouse or long press; keyboard drags start from the grip
      // so Enter on the menu button cannot pick the project up.
      onKeyDown={undefined}
      data-space-project={projectKey(project)}
      className={cn(
        "group flex cursor-grab touch-manipulation select-none items-center gap-2 rounded-xl bg-foreground/5 py-1.5 pr-1 pl-0.5 hover:bg-foreground/9 active:cursor-grabbing",
        isDragging && "opacity-40",
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Drag ${project.title}`}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 group-hover:text-muted-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <GripVerticalIcon aria-hidden className="size-3.5" />
      </button>
      <ProjectSummary project={project} detail={detail} />
      <Menu>
        <MenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label={`Move ${project.title} to Space`} />
          }
        >
          <MoreHorizontalIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup>
          <MenuGroup>
            <MenuGroupLabel>Move to</MenuGroupLabel>
            <MenuRadioGroup
              value={spaceId ?? "none"}
              onValueChange={(next) => move(next === "none" ? null : next)}
            >
              {spaces.spaces.map((space) => (
                <MenuRadioItem key={space.id} value={space.id}>
                  {space.name}
                </MenuRadioItem>
              ))}
              <MenuRadioItem value="none">No Space</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </MenuPopup>
      </Menu>
    </div>
  );
}

function SpaceColumn({
  space,
  active,
  count,
  onEdit,
  onDelete,
  children,
}: {
  space: Space | null;
  active: boolean;
  count: number;
  onEdit: (space: Space) => void;
  onDelete: (space: Space) => void;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnKey(space?.id ?? null) });
  const selectSpace = useSelectSpace();
  const { resolvedTheme } = useTheme();
  const name = space?.name ?? "No Space";
  const colors = spacePreviewColors(space?.theme ?? null, resolvedTheme);
  const style: CSSProperties | undefined = colors
    ? ({
        background: `linear-gradient(165deg, ${colors.sidebar}, ${colors.accentSurface})`,
        color: colors.text,
        "--color-foreground": colors.text,
        "--color-muted-foreground": colors.textMuted,
        "--color-border": colors.border,
        "--color-ring": colors.focus,
      } as CSSProperties)
    : undefined;
  return (
    // The full-height section is the drop target; the visible card only grows with its projects.
    <section
      ref={setNodeRef}
      data-space-column={space?.id ?? "unassigned"}
      aria-label={`Projects in ${name}`}
      className="flex w-72 shrink-0 flex-col"
    >
      <div
        className={cn(
          "flex max-h-full min-h-0 flex-col rounded-2xl border p-2 transition-[border-color,box-shadow] duration-150",
          space ? "bg-sidebar/60" : "border-dashed",
          isOver ? "border-ring ring-2 ring-ring/30" : "border-border/60",
        )}
        style={style}
      >
        <header className="flex items-center gap-2 px-2 pt-1 pb-2">
          <h2 className="min-w-0 flex-1 text-sm font-semibold">
            {space ? (
              <button
                type="button"
                onClick={() => void selectSpace(space.id).catch(reportSpaceError)}
                aria-label={`Open Space ${name}`}
                className="group/open flex max-w-full cursor-pointer items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full bg-muted-foreground/45"
                  style={colors ? { backgroundColor: colors.accent } : undefined}
                />
                <span className="truncate">{name}</span>
                <ArrowUpRightIcon
                  aria-hidden
                  className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover/open:opacity-100 group-focus-visible/open:opacity-100"
                />
              </button>
            ) : (
              <span className="text-muted-foreground">{name}</span>
            )}
          </h2>
          {active ? (
            <span className="rounded-full bg-foreground/8 px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
              Current
            </span>
          ) : null}
          <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
          {space ? (
            <Menu>
              <MenuTrigger
                render={<Button variant="ghost" size="icon-xs" aria-label={`${name} options`} />}
              >
                <MoreHorizontalIcon aria-hidden />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => onEdit(space)}>
                  <PencilIcon aria-hidden />
                  Edit Space…
                </MenuItem>
                <MenuSeparator />
                <MenuItem variant="destructive" onClick={() => onDelete(space)}>
                  <Trash2Icon aria-hidden />
                  Delete Space…
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
        </header>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {children}
          {count === 0 ? (
            <p className="rounded-xl border border-dashed border-border/70 px-3 py-6 text-center text-xs text-muted-foreground">
              {space ? "Drag projects here" : "Projects outside a Space appear here"}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function SpacesView() {
  const spaces = useClientSettings((settings) => settings.spaces);
  const projects = useProjects();
  const { environments } = useEnvironments();
  useCustomThemes();
  useEnvironmentThemeDefinitions();
  const [dragged, setDragged] = useState<EnvironmentProject | null>(null);
  const [editor, setEditor] = useState<{ open: boolean; space: Space | null }>({
    open: false,
    space: null,
  });
  const [deleting, setDeleting] = useState<Space | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const environmentLabels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  // An environment label only helps tell projects apart when more than one is connected.
  const showEnvironment = new Set(projects.map((project) => project.environmentId)).size > 1;
  const columns = [...spaces.spaces, null];
  const dragEnd = (event: DragEndEvent) => {
    setDragged(null);
    const project = projects.find((entry) => projectKey(entry) === event.active.id);
    const destination =
      event.over && columns.find((space) => columnKey(space?.id ?? null) === event.over?.id);
    if (!project || destination === undefined || !event.over) return;
    const spaceId = destination?.id ?? null;
    void updateSpaces((state) =>
      assignProjectSpace(state, scopeProjectRef(project.environmentId, project.id), spaceId),
    ).catch(reportSpaceError);
  };
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <div className="flex min-w-0 flex-1 items-baseline gap-3">
          <h1 className="shrink-0 text-sm font-medium">Spaces</h1>
          <p className="hidden truncate text-xs text-muted-foreground md:block">
            Drag projects between Spaces. Threads follow their project unless moved on their own.
          </p>
        </div>
        <Button size="sm" onClick={() => setEditor({ open: true, space: null })}>
          <PlusIcon aria-hidden />
          New Space
        </Button>
      </WorkspacePageHeader>
      <DndContext
        accessibility={{
          announcements: {
            onDragStart: ({ active }) =>
              `Picked up ${projects.find((project) => projectKey(project) === active.id)?.title ?? "project"}.`,
            onDragMove: () => undefined,
            onDragOver: ({ over }) =>
              over
                ? `Over ${columns.find((space) => columnKey(space?.id ?? null) === over.id)?.name ?? "No Space"}.`
                : "Outside a Space.",
            onDragEnd: ({ over }) =>
              over
                ? `Dropped in ${columns.find((space) => columnKey(space?.id ?? null) === over.id)?.name ?? "No Space"}.`
                : "Project move canceled.",
            onDragCancel: () => "Project move canceled.",
          },
        }}
        sensors={sensors}
        collisionDetection={(args) =>
          args.pointerCoordinates ? pointerWithin(args) : closestCenter(args)
        }
        onDragStart={(event) =>
          setDragged(projects.find((entry) => projectKey(entry) === event.active.id) ?? null)
        }
        onDragEnd={dragEnd}
        onDragCancel={() => setDragged(null)}
      >
        <div
          className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-6 pt-2 pb-6"
          aria-label="Space projects"
        >
          {columns.map((space) => {
            const spaceId = space?.id ?? null;
            const members = projects.filter(
              (project) =>
                resolveProjectSpace(spaces, scopeProjectRef(project.environmentId, project.id)) ===
                spaceId,
            );
            return (
              <SpaceColumn
                key={columnKey(spaceId)}
                space={space}
                active={space !== null && spaces.activeSpaceId === spaceId}
                count={members.length}
                onEdit={(target) => setEditor({ open: true, space: target })}
                onDelete={setDeleting}
              >
                {members.map((project) => (
                  <SpaceProject
                    key={projectKey(project)}
                    project={project}
                    spaceId={spaceId}
                    detail={
                      showEnvironment
                        ? (environmentLabels.get(project.environmentId) ??
                          "Disconnected environment")
                        : undefined
                    }
                  />
                ))}
              </SpaceColumn>
            );
          })}
        </div>
        <DragOverlay dropAnimation={null}>
          {dragged ? (
            <div className="flex w-68 cursor-grabbing items-center gap-2 rounded-xl border bg-popover py-2 pr-3 pl-2.5 text-popover-foreground shadow-lg">
              <ProjectSummary project={dragged} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      <SpaceEditorDialog
        open={editor.open}
        space={editor.space}
        onOpenChange={(open) => setEditor((current) => ({ ...current, open }))}
      />
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its projects and threads move to No Space and stay available in All Spaces.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const target = deleting;
                setDeleting(null);
                if (target)
                  void updateSpaces((state) => removeSpace(state, target.id)).catch(
                    reportSpaceError,
                  );
              }}
            >
              Delete Space
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SidebarInset>
  );
}
