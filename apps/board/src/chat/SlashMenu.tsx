import { useEffect } from "react";

import { GROUP_ORDER, GROUP_TITLE, type SlashItem } from "./slash";

// The lanes that time the menu set this flag, so an ordinary session does not collect marks.
export const MARK_SLASH = localStorage.getItem("board:slash-marks") === "1";

export const slashOptionId = (listId: string, item: SlashItem) => `${listId}-${item.id}`;

/** The filtered slash menu above the composer. Focus stays in the textarea, which names the highlighted option. */
export function SlashMenu({
  id,
  items,
  active,
  onPick,
  onHover,
}: {
  id: string;
  items: ReadonlyArray<SlashItem>;
  active: number;
  onPick: (item: SlashItem) => void;
  onHover: (index: number) => void;
}) {
  // Two frames after the commit: the first runs the commit's paint, the second follows it.
  useEffect(() => {
    if (!MARK_SLASH) return;
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => performance.mark("board:slash-painted")),
    );
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="absolute inset-x-2 bottom-full z-20 mb-1 max-h-[min(20rem,45vh)] overflow-y-auto rounded-xl border border-line bg-panel py-1 shadow-panel">
      {items.length === 0 ? (
        <p className="px-3 py-2 text-muted">No matching command.</p>
      ) : (
        <ul id={id} role="listbox" aria-label="Commands and skills">
          {GROUP_ORDER.map((group) => {
            const inGroup = items.filter((item) => item.group === group);
            if (inGroup.length === 0) return null;
            return (
              <li key={group} role="presentation">
                <p className="px-3 pt-1.5 pb-0.5 text-[11px] font-medium text-faint">
                  {GROUP_TITLE[group]}
                </p>
                <ul role="presentation">
                  {inGroup.map((item) => {
                    const selected = items[active]?.id === item.id;
                    return (
                      <li
                        key={item.id}
                        id={slashOptionId(id, item)}
                        ref={
                          selected ? (row) => row?.scrollIntoView({ block: "nearest" }) : undefined
                        }
                        role="option"
                        aria-selected={selected}
                        // The textarea keeps focus through a click.
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => onPick(item)}
                        onMouseMove={() => {
                          if (!selected) onHover(items.indexOf(item));
                        }}
                        className={`flex cursor-pointer items-baseline gap-2 px-3 py-1 ${selected ? "bg-hover" : ""}`}
                      >
                        <span className="shrink-0 font-medium text-fg">{item.label}</span>
                        {item.hint !== null && (
                          <span className="max-w-[40%] shrink-0 truncate text-faint">
                            {item.hint}
                          </span>
                        )}
                        <span className="min-w-0 flex-1 truncate text-muted">
                          {item.description}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
