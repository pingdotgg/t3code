import { type ReactNode, useId, useState } from "react";

export interface PopMenuItem {
  readonly label: string;
  /** A dim note at the item's right edge, such as why it is off. */
  readonly hint?: string | undefined;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

/** A button that opens a menu of actions, shaped like Orca's menus: label left, hint right. Escape and a click away close it. */
export function PopMenu({
  label,
  trigger,
  items,
  align = "end",
  triggerClass,
}: {
  label: string;
  trigger: ReactNode;
  items: ReadonlyArray<PopMenuItem>;
  align?: "start" | "end";
  triggerClass: string;
}) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (
          open &&
          !(
            event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)
          )
        ) {
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
        className={triggerClass}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className={`absolute top-full z-30 mt-1 flex w-max min-w-52 flex-col rounded-lg border border-line bg-panel p-1 shadow-panel ${align === "end" ? "right-0" : "left-0"}`}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled === true}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className="flex items-center justify-between gap-6 rounded-md px-2 py-1.5 text-left text-[12px] whitespace-nowrap enabled:hover:bg-hover enabled:focus-visible:bg-hover disabled:text-faint"
            >
              {item.label}
              {item.hint !== undefined && (
                <span className="text-[11px] text-faint">{item.hint}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
