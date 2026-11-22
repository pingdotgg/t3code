import { ListFilterIcon, TagIcon } from "lucide-react";
import { T, useGT } from "gt-react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import {
  BOARD_COLUMN_IDS,
  BOARD_COLUMN_STATUS_SLUGS,
  STATUS_LABEL_PREFIX,
} from "./boardColumns.logic";

const STATUS_OPTIONS = BOARD_COLUMN_IDS.map(
  (id) => `${STATUS_LABEL_PREFIX}${BOARD_COLUMN_STATUS_SLUGS[id]}`,
);

export function BoardLabelFilter({
  selected,
  otherLabels,
  onChange,
}: {
  selected: ReadonlyArray<string>;
  /** Non-status labels present on loaded issues. */
  otherLabels: ReadonlyArray<string>;
  onChange: (labels: ReadonlyArray<string>) => void;
}) {
  const gt = useGT();
  const selectedSet = new Set(selected.map((name) => name.toLowerCase()));
  const toggle = (name: string) => {
    const key = name.toLowerCase();
    if (selectedSet.has(key)) {
      onChange(selected.filter((existing) => existing.toLowerCase() !== key));
      return;
    }
    onChange([...selected, name]);
  };

  return (
    <Menu>
      <MenuTrigger render={<Button variant="outline" />}>
        <ListFilterIcon className="size-4" />
        <span>
          <T>Labels</T>
        </span>
        {selected.length > 0 ? (
          <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
            {selected.length}
          </span>
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="max-h-80 overflow-y-auto">
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
          {gt("Column status")}
        </div>
        {STATUS_OPTIONS.map((name) => (
          <MenuCheckboxItem
            key={name}
            checked={selectedSet.has(name.toLowerCase())}
            onClick={() => toggle(name)}
          >
            <TagIcon aria-hidden className="size-3.5" />
            {name}
          </MenuCheckboxItem>
        ))}
        {otherLabels.length > 0 ? (
          <>
            <MenuSeparator />
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              {gt("Other labels")}
            </div>
            {otherLabels.map((name) => (
              <MenuCheckboxItem
                key={name}
                checked={selectedSet.has(name.toLowerCase())}
                onClick={() => toggle(name)}
              >
                <TagIcon aria-hidden className="size-3.5" />
                {name}
              </MenuCheckboxItem>
            ))}
          </>
        ) : null}
        {selected.length > 0 ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => onChange([])}>
              <T>Clear labels</T>
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
