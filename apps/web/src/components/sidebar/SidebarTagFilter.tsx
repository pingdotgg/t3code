import { TagIcon, TagsIcon, XIcon } from "lucide-react";
import { threadTagKey } from "@t3tools/contracts";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

const ALL_TAGS = "\u0000all";

/** Each click or Enter toggles a tag and the list stays open; "All tags" clears the filter. */
export function SidebarTagFilterMenu(props: {
  readonly tags: ReadonlyArray<string>;
  readonly active: ReadonlyArray<string>;
  readonly onChange: (tags: ReadonlyArray<string>) => void;
}) {
  const [query, setQuery] = useState("");
  // A saved filter can name a tag no thread carries any more; keep it listed so it can be unchecked.
  const hasTag = (list: ReadonlyArray<string>, tag: string) =>
    list.some((existing) => threadTagKey(existing) === threadTagKey(tag));
  const tags = [...props.tags, ...props.active.filter((tag) => !hasTag(props.tags, tag))];
  if (tags.length === 0) return null;
  const needle = query.trim().toLowerCase();
  const items = [ALL_TAGS, ...tags];
  const filtered = needle === "" ? items : tags.filter((tag) => tag.toLowerCase().includes(needle));

  return (
    <Combobox
      items={items}
      filteredItems={filtered}
      autoHighlight
      value={null}
      onOpenChange={(open) => (open ? undefined : setQuery(""))}
      onValueChange={(item, eventDetails) => {
        if (!item) return;
        // Canceling skips Base UI's commit and its close, so the list stays open for more toggles.
        eventDetails.cancel();
        if (item === ALL_TAGS) {
          props.onChange([]);
          return;
        }
        props.onChange(
          hasTag(props.active, item)
            ? props.active.filter((existing) => threadTagKey(existing) !== threadTagKey(item))
            : [...props.active, item],
        );
      }}
    >
      <ComboboxTrigger
        render={
          <SidebarHeaderIconButton
            label={
              props.active.length === 0
                ? "Filter threads by tag"
                : `Filtering by tag: ${props.active.join(", ")}`
            }
          />
        }
      >
        {props.active.length > 1 ? <TagsIcon className="size-4" /> : <TagIcon className="size-4" />}
      </ComboboxTrigger>
      <ComboboxPopup
        align="start"
        collisionAvoidance={{ side: "flip", align: "shift" }}
        className="w-[min(16rem,var(--available-width))] overflow-hidden"
      >
        <ComboboxSearchInput
          aria-label="Search tags"
          placeholder="Search tags..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>No matching tags.</ComboboxEmpty>
        <ComboboxList aria-multiselectable>
          {(item: string) => {
            const isSelected =
              item === ALL_TAGS ? props.active.length === 0 : hasTag(props.active, item);
            return (
              <ComboboxItem
                key={item}
                hideIndicator
                value={item}
                aria-selected={isSelected}
                // The checkbox marks selection; Base UI's single value would shade one row.
                data-selected={undefined}
              >
                <Checkbox checked={isSelected} tabIndex={-1} aria-hidden />
                <span className="min-w-0 truncate text-sm">
                  {item === ALL_TAGS ? "All tags" : item}
                </span>
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

export function SidebarTagFilterBar(props: {
  readonly active: ReadonlyArray<string>;
  readonly onClear: () => void;
}) {
  if (props.active.length === 0) return null;
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-2 text-xs text-sidebar-muted-foreground">
      <span className="shrink-0">{props.active.length === 1 ? "Tag" : "Tags"}</span>
      <span className="flex min-w-0 items-center gap-1 overflow-hidden">
        {props.active.map((tag) => (
          <Badge
            key={tag}
            variant="outline"
            title={tag}
            className="min-w-0 max-w-24 shrink justify-start"
          >
            <span className="truncate">{tag}</span>
          </Badge>
        ))}
      </span>
      <Button
        type="button"
        size="icon-micro"
        variant="ghost-muted"
        aria-label="Clear tag filter"
        onClick={props.onClear}
      >
        <XIcon className="size-3" />
      </Button>
    </div>
  );
}
