import { ListTreeIcon } from "lucide-react";
import { xcodeMarkMenuLabel, type XcodeMark } from "@t3tools/shared/xcodeMarks";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";

export function FileMarksMenu(props: {
  readonly marks: ReadonlyArray<XcodeMark>;
  readonly onSelect: (line: number) => void;
}) {
  if (props.marks.length === 0) return null;

  const items: Array<
    { kind: "item"; mark: XcodeMark; label: string } | { kind: "separator"; afterLine: number }
  > = [];
  for (const mark of props.marks) {
    if (mark.separator && items.length > 0 && items[items.length - 1]?.kind !== "separator") {
      items.push({ kind: "separator", afterLine: mark.line });
    }
    const label = xcodeMarkMenuLabel(mark);
    if (label !== null) items.push({ kind: "item", mark, label });
  }

  if (items.length === 0) return null;

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            className="shrink-0"
            aria-label="Jump to mark"
            title="Jump to mark"
            variant="ghost"
            size="icon-sm"
          />
        }
      >
        <ListTreeIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" width="content" className="min-w-48">
        {items.map((item) =>
          item.kind === "separator" ? (
            <MenuSeparator key={`separator:${item.afterLine}`} />
          ) : (
            <MenuItem
              key={`${item.mark.line}:${item.label}`}
              onClick={() => props.onSelect(item.mark.line)}
            >
              <span
                className={cn(
                  item.mark.kind === "mark" && "font-medium text-muted-foreground",
                  item.mark.kind === "todo" && "font-medium text-warning-foreground",
                  item.mark.kind === "fixme" && "font-medium text-destructive",
                )}
              >
                {item.label}
              </span>
            </MenuItem>
          ),
        )}
      </MenuPopup>
    </Menu>
  );
}
