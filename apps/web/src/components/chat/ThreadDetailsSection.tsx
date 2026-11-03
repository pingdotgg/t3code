import { type ComponentProps, type ReactNode, type Ref, useId, useState } from "react";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { ThreadDetailsControl } from "./ThreadDetailsControl";

const cardOrderSchema = Schema.Array(Schema.String);
const DEFAULT_ORDER = ["Servers", "Automations", "Lineage", "Side chats"];

/** The workspace stays first; other cards remember their collapse state and drag order. */
export function ThreadDetailsSection({
  title,
  children,
  contentRef,
  summary,
  action,
  empty = false,
  variant = "card",
  spacing = "default",
  ...props
}: Omit<ComponentProps<"section">, "className" | "style" | "title" | "aria-labelledby"> & {
  title: string;
  contentRef?: Ref<HTMLDivElement>;
  summary?: ReactNode;
  action?: ReactNode;
  empty?: boolean;
  variant?: "card" | "workspace" | "usage";
  spacing?: "default" | "relaxed";
}) {
  const contentId = useId();
  const [collapsed, setCollapsed] = useLocalStorage(
    "thread-details:collapsed:" + title,
    false,
    Schema.Boolean,
  );
  // Empty cards start closed. A content transition overrides a saved collapse,
  // while a click still remembers the user's preference for populated cards.
  const [disclosure, setDisclosure] = useState<{ empty: boolean; collapsed: boolean | null }>({
    empty,
    collapsed: empty ? true : null,
  });
  if (disclosure.empty !== empty) setDisclosure({ empty, collapsed: empty });
  const isCollapsed = disclosure.collapsed ?? collapsed;
  const [order, setOrder] = useLocalStorage(
    "thread-details:card-order",
    DEFAULT_ORDER,
    cardOrderSchema,
  );
  const card = variant === "card";
  return (
    <section
      {...props}
      aria-label={title}
      className={cn(card && "surface-tray rounded-pane p-1")}
      style={card ? { order: Math.max(0, order.indexOf(title)) + 1 } : undefined}
      onDragOver={
        card
          ? (event) => {
              if (event.dataTransfer.types.includes("application/x-t3-details-card"))
                event.preventDefault();
            }
          : undefined
      }
      onDrop={
        card
          ? (event) => {
              const source = event.dataTransfer.getData("application/x-t3-details-card");
              if (!DEFAULT_ORDER.includes(source) || source === title) return;
              event.preventDefault();
              const next = [...new Set([...order, ...DEFAULT_ORDER])].filter(
                (item) => item !== source,
              );
              next.splice(Math.max(0, next.indexOf(title)), 0, source);
              setOrder(next);
            }
          : undefined
      }
    >
      {card ? (
        <div
          className={cn(
            "flex items-center gap-1 ps-3 pe-1",
            isCollapsed ? "h-7" : spacing === "relaxed" ? "h-7.5 pb-1" : "h-6.5 pb-1",
          )}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData("application/x-t3-details-card", title);
            event.dataTransfer.effectAllowed = "move";
          }}
        >
          <ThreadDetailsControl
            part="heading"
            aria-expanded={!isCollapsed}
            aria-controls={contentId}
            onClick={() => {
              setCollapsed(!isCollapsed);
              setDisclosure({ empty, collapsed: empty ? !isCollapsed : null });
            }}
          >
            <span className="shrink-0">{title}</span>
            {summary ? (
              <span className="ms-auto truncate text-caption text-muted-foreground">{summary}</span>
            ) : null}
          </ThreadDetailsControl>
          {action}
        </div>
      ) : null}
      <div
        id={contentId}
        ref={contentRef}
        hidden={card && isCollapsed}
        className={cn(
          "flex flex-col",
          card && "surface-composer rounded-lg p-0.5",
          card && isCollapsed && "hidden",
        )}
      >
        {children}
      </div>
    </section>
  );
}
