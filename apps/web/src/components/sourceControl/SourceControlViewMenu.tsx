import type { HistoryFilter } from "@t3tools/client-runtime/state/working-copy-logic";
import { Settings2 } from "lucide-react";

import type { ChangesStatusFilter } from "~/lib/sourceControl/changesRows";
import type { SourceControlPrefs } from "~/sourceControlStore";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";

const CHANGES_FILTER_LABEL: Record<ChangesStatusFilter, string> = {
  all: "All files",
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "Untracked",
};

export function SourceControlViewMenu(props: {
  readonly prefs: SourceControlPrefs;
  readonly historyFilter: HistoryFilter;
  readonly authors: ReadonlyArray<{ readonly name: string; readonly count: number }>;
  readonly onPrefsChange: (patch: Partial<SourceControlPrefs>) => void;
  readonly onHistoryFilterChange: (filter: HistoryFilter) => void;
}) {
  const onChanges = props.prefs.activeSection === "changes";
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-xs" variant="ghost" aria-label="Source control view options" />}
      >
        <Settings2 />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" sideOffset={6} className="min-w-52">
        {onChanges ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>Show</MenuGroupLabel>
              <MenuRadioGroup
                value={props.prefs.filter}
                onValueChange={(value) =>
                  props.onPrefsChange({ filter: value as ChangesStatusFilter })
                }
              >
                {(Object.keys(CHANGES_FILTER_LABEL) as ReadonlyArray<ChangesStatusFilter>).map(
                  (value) => (
                    <MenuRadioItem key={value} value={value}>
                      {CHANGES_FILTER_LABEL[value]}
                    </MenuRadioItem>
                  ),
                )}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Layout</MenuGroupLabel>
              <MenuRadioGroup
                value={props.prefs.viewMode}
                onValueChange={(value) =>
                  props.onPrefsChange({ viewMode: value === "tree" ? "tree" : "flat" })
                }
              >
                <MenuRadioItem value="flat">Flat list</MenuRadioItem>
                <MenuRadioItem value="tree">Folder tree</MenuRadioItem>
              </MenuRadioGroup>
            </MenuGroup>
          </>
        ) : (
          <>
            <MenuSub>
              <MenuSubTrigger>
                <span className="min-w-0 max-w-40 truncate">
                  {props.historyFilter.author.length > 0
                    ? `Author: ${props.historyFilter.author}`
                    : "Author: all"}
                </span>
              </MenuSubTrigger>
              <MenuSubPopup className="max-h-64 min-w-48 overflow-auto">
                <MenuItem
                  onClick={() =>
                    props.onHistoryFilterChange({ ...props.historyFilter, author: "" })
                  }
                >
                  All authors
                </MenuItem>
                {props.authors.map((author) => (
                  <MenuItem
                    key={author.name}
                    onClick={() =>
                      props.onHistoryFilterChange({
                        ...props.historyFilter,
                        author: author.name,
                      })
                    }
                  >
                    <span className="min-w-0 max-w-48 truncate">{author.name}</span>
                    <span className="ml-auto text-muted-foreground">{author.count}</span>
                  </MenuItem>
                ))}
              </MenuSubPopup>
            </MenuSub>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Group</MenuGroupLabel>
              <MenuRadioGroup
                value={props.prefs.historyGrouped ? "day" : "none"}
                onValueChange={(value) => props.onPrefsChange({ historyGrouped: value === "day" })}
              >
                <MenuRadioItem value="none">No grouping</MenuRadioItem>
                <MenuRadioItem value="day">By day</MenuRadioItem>
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Sort</MenuGroupLabel>
              <MenuRadioGroup
                value={props.prefs.historySort}
                onValueChange={(value) =>
                  props.onPrefsChange({ historySort: value === "oldest" ? "oldest" : "newest" })
                }
              >
                <MenuRadioItem value="newest">Newest first</MenuRadioItem>
                <MenuRadioItem value="oldest">Oldest first</MenuRadioItem>
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Density</MenuGroupLabel>
              <MenuRadioGroup
                value={props.prefs.historyDensity}
                onValueChange={(value) =>
                  props.onPrefsChange({
                    historyDensity: value === "compact" ? "compact" : "comfort",
                  })
                }
              >
                <MenuRadioItem value="comfort">Comfortable rows</MenuRadioItem>
                <MenuRadioItem value="compact">Compact rows</MenuRadioItem>
              </MenuRadioGroup>
            </MenuGroup>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}
