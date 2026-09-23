import type { ThreadDetailsSectionsSetting } from "@t3tools/contracts";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { GripVerticalIcon, PencilIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { cn } from "../../lib/utils";
import {
  THREAD_DETAILS_SECTIONS,
  THREAD_DETAILS_SECTION_BY_ID,
  type ThreadDetailsSectionDefinition,
  type ThreadDetailsSectionId,
  type ThreadDetailsVisibilityMode,
  dropThreadDetailsSection,
  setThreadDetailsSectionMode,
  threadDetailsItemVisible,
  threadDetailsSectionMode,
} from "./threadDetailsCustomization";

const VISIBILITY_OPTIONS = [
  { value: "always", label: "Always" },
  { value: "relevant", label: "Auto" },
  { value: "hidden", label: "Hidden" },
] as const satisfies ReadonlyArray<{ value: ThreadDetailsVisibilityMode; label: string }>;

type DropZone = "panel" | "tray";

function setItemVisible(
  sections: ThreadDetailsSectionsSetting,
  sectionId: ThreadDetailsSectionId,
  itemId: string,
  visible: boolean,
): ThreadDetailsSectionsSetting {
  const previous = sections.sections[sectionId];
  return {
    sections: {
      ...sections.sections,
      [sectionId]: { ...previous, items: { ...previous?.items, [itemId]: visible } },
    },
  };
}

function isSectionId(value: unknown): value is ThreadDetailsSectionId {
  return typeof value === "string" && value in THREAD_DETAILS_SECTION_BY_ID;
}

/** Enters edit mode. Hidden until the card is hovered or focused, so it never competes with content. */
export function ThreadDetailsCustomizeButton(props: { readonly onClick: () => void }) {
  return (
    <div className="absolute top-2 right-2 z-10 opacity-0 transition-opacity duration-100 group-focus-within/thread-details:opacity-100 group-hover/thread-details:opacity-100 focus-within:opacity-100">
      <Button
        aria-label="Customize thread details"
        size="icon-sm"
        variant="ghost"
        onClick={props.onClick}
      >
        <PencilIcon className="size-3.5" />
      </Button>
    </div>
  );
}

function SectionVisibilityControl(props: {
  readonly section: ThreadDetailsSectionDefinition;
  readonly value: ThreadDetailsVisibilityMode;
  readonly onChange: (mode: ThreadDetailsVisibilityMode) => void;
}) {
  return (
    <ToggleGroup
      aria-label={`${props.section.title} visibility`}
      value={[props.value]}
      variant="segmented"
      onValueChange={(next) => {
        const selected = VISIBILITY_OPTIONS.find((option) => option.value === next[0]);
        if (selected) props.onChange(selected.value);
      }}
    >
      {VISIBILITY_OPTIONS.map((option) => (
        <Toggle key={option.value} value={option.value}>
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

function SectionTileBody(props: {
  readonly section: ThreadDetailsSectionDefinition;
  readonly sections: ThreadDetailsSectionsSetting;
  readonly draftLocked: boolean;
  readonly handle: ReactNode;
  readonly onChange?: (sections: ThreadDetailsSectionsSetting) => void;
}) {
  const { section, sections, onChange } = props;
  const mode = threadDetailsSectionMode(sections, section.id);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border/65 bg-background/60 p-2 text-[13px]">
      <div className="flex min-w-0 items-center gap-1">
        {props.handle}
        <span className="min-w-0 truncate font-medium">{section.title}</span>
      </div>
      <SectionVisibilityControl
        section={section}
        value={mode}
        onChange={(next) => onChange?.(setThreadDetailsSectionMode(sections, section.id, next))}
      />
      {props.draftLocked && mode !== "hidden" ? (
        <p className="text-[11px] text-muted-foreground/70">Available after the thread starts.</p>
      ) : null}
      {mode !== "hidden" && !props.draftLocked && section.items.length > 0 ? (
        <ul className="m-0 list-none p-0">
          {section.items.map((item) => (
            <li key={item.id}>
              <label className="flex cursor-pointer items-center gap-2 py-0.5 text-muted-foreground">
                <Checkbox
                  checked={threadDetailsItemVisible(sections, section.id, item.id)}
                  onCheckedChange={(checked) =>
                    onChange?.(setItemVisible(sections, section.id, item.id, checked === true))
                  }
                />
                <span className="truncate">{item.label}</span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function DraggableSectionTile(props: {
  readonly section: ThreadDetailsSectionDefinition;
  readonly sections: ThreadDetailsSectionsSetting;
  readonly draftLocked: boolean;
  readonly onChange: (sections: ThreadDetailsSectionsSetting) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: props.section.id,
  });
  return (
    <li ref={setNodeRef} className={cn(isDragging && "opacity-40")}>
      <SectionTileBody
        {...props}
        handle={
          <button
            type="button"
            aria-label={`Drag ${props.section.title}`}
            className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVerticalIcon className="size-3.5" />
          </button>
        }
      />
    </li>
  );
}

function SectionDropZone(props: {
  readonly zone: DropZone;
  readonly label: string;
  readonly emptyLabel: string;
  readonly children: ReactNode;
  readonly isEmpty: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: props.zone });
  return (
    <ul
      ref={setNodeRef}
      aria-label={props.label}
      className={cn(
        "m-0 flex min-h-16 list-none flex-col gap-1.5 rounded-xl p-1 transition-colors duration-100",
        isOver && "bg-accent/60",
      )}
    >
      {props.children}
      {props.isEmpty ? (
        <li className="flex min-h-14 items-center justify-center rounded-xl border border-dashed border-border px-2 text-center text-[11px] text-muted-foreground">
          {props.emptyLabel}
        </li>
      ) : null}
    </ul>
  );
}

/**
 * Edit mode for the thread details panel. The panel card lists what it shows,
 * and a tray beside it holds hidden sections. Sections move between them by
 * dragging or by picking a visibility; nothing persists until Done.
 */
export function ThreadDetailsEditor(props: {
  readonly availableForDraft: ReadonlyArray<ThreadDetailsSectionId>;
  readonly sections: ThreadDetailsSectionsSetting;
  readonly trayClassName: string;
  readonly onChange: (sections: ThreadDetailsSectionsSetting) => void;
  readonly onCancel: () => void;
  readonly onDone: () => void;
  readonly onReset: () => void;
  readonly renderCard: (panelList: ReactNode) => ReactNode;
}) {
  const { sections, onChange, onCancel } = props;
  // Remembers each section's mode while it sits in the tray, so dragging it
  // back restores Always instead of silently downgrading it to Auto.
  const previousModeRef = useRef<Partial<Record<ThreadDetailsSectionId, "always" | "relevant">>>(
    {},
  );
  const [activeId, setActiveId] = useState<ThreadDetailsSectionId | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  // Escape leaves edit mode without saving, unless it is cancelling a drag.
  useEffect(() => {
    if (activeId !== null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activeId, onCancel]);

  // Every change passes through here so a section moved to the tray keeps
  // the mode it had on the panel.
  const handleChange = (next: ThreadDetailsSectionsSetting) => {
    for (const section of THREAD_DETAILS_SECTIONS) {
      const before = threadDetailsSectionMode(sections, section.id);
      if (before !== "hidden" && threadDetailsSectionMode(next, section.id) !== before) {
        previousModeRef.current[section.id] = before;
      }
    }
    onChange(next);
  };
  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const sectionId = event.active.id;
    if (!isSectionId(sectionId) || !event.over) return;
    const zone = event.over.id;
    if (zone !== "panel" && zone !== "tray") return;
    const next = dropThreadDetailsSection({
      sections,
      sectionId,
      zone,
      previousMode: previousModeRef.current[sectionId],
    });
    if (next) handleChange(next);
  };

  const availableForDraft = new Set(props.availableForDraft);
  const onPanel = THREAD_DETAILS_SECTIONS.filter(
    (section) => threadDetailsSectionMode(sections, section.id) !== "hidden",
  );
  const hidden = THREAD_DETAILS_SECTIONS.filter(
    (section) => threadDetailsSectionMode(sections, section.id) === "hidden",
  );
  const renderTiles = (list: ReadonlyArray<ThreadDetailsSectionDefinition>) =>
    list.map((section) => (
      <DraggableSectionTile
        key={section.id}
        draftLocked={!availableForDraft.has(section.id)}
        section={section}
        sections={sections}
        onChange={handleChange}
      />
    ));
  const activeSection = activeId ? THREAD_DETAILS_SECTION_BY_ID[activeId] : null;

  return (
    <DndContext
      sensors={sensors}
      onDragCancel={() => setActiveId(null)}
      onDragEnd={handleDragEnd}
      onDragStart={(event) => setActiveId(isSectionId(event.active.id) ? event.active.id : null)}
    >
      <div
        aria-label="Hidden thread details sections"
        className={cn(
          "dropdown-glass flex w-60 flex-col gap-2 rounded-[20px] p-2",
          props.trayClassName,
        )}
        role="region"
      >
        <div className="px-1.5 pt-1">
          <p className="text-sm font-medium">Customize thread details</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Drag sections on or off the panel. Auto shows a section only when it has something to
            show.
          </p>
        </div>
        <p className="px-1.5 text-[11px] font-medium text-muted-foreground">Hidden</p>
        <SectionDropZone
          emptyLabel="Drag a section here to hide it."
          isEmpty={hidden.length === 0}
          label="Hidden sections"
          zone="tray"
        >
          {renderTiles(hidden)}
        </SectionDropZone>
        <div className="flex flex-col gap-2 border-t border-border/65 px-1 pt-2">
          <Button size="xs" variant="ghost-muted" onClick={props.onReset}>
            Reset to recommended
          </Button>
          <div className="flex items-center justify-end gap-1.5">
            <Button size="xs" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="xs" onClick={props.onDone}>
              Done
            </Button>
          </div>
        </div>
      </div>
      {props.renderCard(
        <div className="px-2 pt-2 pb-2.5">
          <p className="mb-1 min-h-8 px-1.5 pt-2 text-[11px] font-medium text-muted-foreground">
            On the panel
          </p>
          <SectionDropZone
            emptyLabel="Drag a section here to show it."
            isEmpty={onPanel.length === 0}
            label="Sections on the panel"
            zone="panel"
          >
            {renderTiles(onPanel)}
          </SectionDropZone>
        </div>,
      )}
      {/* The card clips and contains paint, so the dragged copy renders at the body. */}
      {createPortal(
        <DragOverlay dropAnimation={null}>
          {activeSection ? (
            <div className="dropdown-glass w-56 rounded-xl">
              <SectionTileBody
                draftLocked={!availableForDraft.has(activeSection.id)}
                handle={
                  <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
                    <GripVerticalIcon className="size-3.5" />
                  </span>
                }
                section={activeSection}
                sections={sections}
              />
            </div>
          ) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}
