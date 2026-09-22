import type { ThreadDetailsSectionsSetting } from "@t3tools/contracts";
import { PencilIcon, PlusIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { cn } from "../../lib/utils";
import {
  THREAD_DETAILS_SECTIONS,
  type ThreadDetailsSectionDefinition,
  type ThreadDetailsSectionId,
  type ThreadDetailsVisibilityMode,
  threadDetailsSectionMode,
} from "./threadDetailsCustomization";

const VISIBILITY_OPTIONS = [
  { value: "always", label: "Always" },
  { value: "relevant", label: "Relevant" },
] as const satisfies ReadonlyArray<{
  value: Exclude<ThreadDetailsVisibilityMode, "hidden">;
  label: string;
}>;

function setSectionMode(
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

function SectionVisibilitySegmentedControl(props: {
  readonly section: ThreadDetailsSectionDefinition;
  readonly value: Exclude<ThreadDetailsVisibilityMode, "hidden">;
  readonly onChange: (mode: Exclude<ThreadDetailsVisibilityMode, "hidden">) => void;
}) {
  return (
    <div
      aria-label={`${props.section.title} visibility`}
      className="flex shrink-0 rounded-lg border border-border/60 p-0.5 text-[11px]"
      role="radiogroup"
    >
      {VISIBILITY_OPTIONS.map((option) => (
        <button
          aria-checked={props.value === option.value}
          className={cn(
            "cursor-pointer rounded-md px-2 py-0.5 font-medium",
            props.value === option.value
              ? "bg-foreground/10 text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
          key={option.value}
          onClick={() => props.onChange(option.value)}
          role="radio"
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ThreadDetailsCustomize(props: {
  readonly availableForDraft: ReadonlyArray<ThreadDetailsSectionId>;
  readonly open: boolean;
  readonly sections: ThreadDetailsSectionsSetting;
  readonly onChange: (sections: ThreadDetailsSectionsSetting) => void;
  readonly onCancel: () => void;
  readonly onDone: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onReset: () => void;
}) {
  const previousModeRef = useRef<Partial<Record<ThreadDetailsSectionId, "always" | "relevant">>>(
    {},
  );
  const [expandedItems, setExpandedItems] = useState<ReadonlySet<ThreadDetailsSectionId>>(
    () => new Set(["workspace", "version-control"]),
  );
  const availableForDraft = new Set(props.availableForDraft);
  const onPanel = THREAD_DETAILS_SECTIONS.filter(
    (section) => threadDetailsSectionMode(props.sections, section.id) !== "hidden",
  );
  const available = THREAD_DETAILS_SECTIONS.filter(
    (section) => threadDetailsSectionMode(props.sections, section.id) === "hidden",
  );

  const includeSection = (section: ThreadDetailsSectionDefinition) => {
    props.onChange(
      setSectionMode(props.sections, section.id, previousModeRef.current[section.id] ?? "relevant"),
    );
  };
  const excludeSection = (section: ThreadDetailsSectionDefinition) => {
    const mode = threadDetailsSectionMode(props.sections, section.id);
    if (mode !== "hidden") previousModeRef.current[section.id] = mode;
    props.onChange(setSectionMode(props.sections, section.id, "hidden"));
  };

  return (
    <Popover onOpenChange={props.onOpenChange} open={props.open}>
      <PopoverTrigger
        aria-label="Customize thread details"
        className={cn(
          "absolute top-2 right-2 z-10 opacity-0 transition-opacity duration-100 group-focus-within/thread-details:opacity-100 group-hover/thread-details:opacity-100 focus-visible:opacity-100 data-[panel-customize-open]:opacity-100",
        )}
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            data-panel-customize-open={props.open ? "" : undefined}
          >
            <PencilIcon className="size-3.5" />
          </Button>
        }
      />
      <PopoverPopup align="start" className="w-80" side="left" sideOffset={8}>
        <div className="flex flex-col gap-3 text-[13px]">
          <div>
            <PopoverTitle className="text-sm">Customize thread details</PopoverTitle>
            <p className="mt-1 text-xs text-muted-foreground">Choose what appears.</p>
          </div>

          <div>
            <p className="px-1 pb-1 text-[11px] font-medium text-muted-foreground">On your panel</p>
            <ul className="m-0 list-none p-0">
              {onPanel.map((section) => {
                const mode = threadDetailsSectionMode(props.sections, section.id);
                const draftLocked = !availableForDraft.has(section.id);
                const itemsExpanded = expandedItems.has(section.id);
                return (
                  <li key={section.id} className="py-1">
                    <div className="flex items-center justify-between gap-2 px-1">
                      <label className="flex min-w-0 cursor-pointer items-center gap-2">
                        <Checkbox
                          aria-label={`Show ${section.title}`}
                          checked
                          onCheckedChange={() => excludeSection(section)}
                        />
                        <span className="truncate">{section.title}</span>
                      </label>
                      <SectionVisibilitySegmentedControl
                        section={section}
                        value={mode === "hidden" ? "relevant" : mode}
                        onChange={(next) =>
                          props.onChange(setSectionMode(props.sections, section.id, next))
                        }
                      />
                    </div>
                    {draftLocked ? (
                      <p className="px-1 pt-1 text-[11px] text-muted-foreground/70">
                        Available after the thread starts.
                      </p>
                    ) : null}
                    {section.items.length > 0 && !draftLocked ? (
                      <div className="pl-6">
                        <button
                          aria-expanded={itemsExpanded}
                          className="cursor-pointer py-1 text-[11px] text-muted-foreground hover:text-foreground"
                          onClick={() =>
                            setExpandedItems((current) => {
                              const next = new Set(current);
                              if (next.has(section.id)) {
                                next.delete(section.id);
                              } else {
                                next.add(section.id);
                              }
                              return next;
                            })
                          }
                          type="button"
                        >
                          {itemsExpanded ? "Hide items" : `${section.items.length} items`}
                        </button>
                        {itemsExpanded ? (
                          <ul className="m-0 list-none p-0">
                            {section.items.map((item) => {
                              const visible =
                                props.sections.sections[section.id]?.items?.[item.id] !== false;
                              return (
                                <li key={item.id}>
                                  <label className="flex cursor-pointer items-center gap-2 py-1 text-muted-foreground">
                                    <Checkbox
                                      checked={visible}
                                      onCheckedChange={(checked) =>
                                        props.onChange(
                                          setItemVisible(
                                            props.sections,
                                            section.id,
                                            item.id,
                                            checked === true,
                                          ),
                                        )
                                      }
                                    />
                                    <span className="truncate">{item.label}</span>
                                  </label>
                                </li>
                              );
                            })}
                          </ul>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>

          {available.length > 0 ? (
            <div>
              <p className="px-1 pb-1 text-[11px] font-medium text-muted-foreground">
                Available sections
              </p>
              <ul className="m-0 list-none p-0">
                {available.map((section) => (
                  <li
                    className="flex items-center justify-between gap-2 px-1 py-1"
                    key={section.id}
                  >
                    <span className="truncate text-muted-foreground">{section.title}</span>
                    <Button size="xs" variant="ghost" onClick={() => includeSection(section)}>
                      <PlusIcon className="size-3.5" />
                      Add
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-2 border-t border-border/65 pt-3">
            <Button size="xs" variant="ghost-muted" onClick={props.onReset}>
              Reset to recommended
            </Button>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button size="xs" variant="ghost" onClick={props.onCancel}>
                Cancel
              </Button>
              <Button size="xs" onClick={props.onDone}>
                Done
              </Button>
            </div>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
