import { use, useId, useLayoutEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { definePluginComponent, createPluginContext } from "~/plugins/features";

export const WorkLogBlock = definePluginComponent(
  "component:components/chat/WorkLog/WorkLogBlock",
  PluginOriginalWorkLogBlock,
);
export const WorkLogList = definePluginComponent(
  "component:components/chat/WorkLog/WorkLogList",
  PluginOriginalWorkLogList,
);
const WorkLogLine = definePluginComponent(
  "component:components/chat/WorkLog/WorkLogLine",
  PluginOriginalWorkLogLine,
);
export const WorkLogButton = definePluginComponent(
  "component:components/chat/WorkLog/WorkLogButton",
  PluginOriginalWorkLogButton,
);
export const WorkLogRow = definePluginComponent(
  "component:components/chat/WorkLog/WorkLogRow",
  PluginOriginalWorkLogRow,
);
export const WorkLogDetails = definePluginComponent(
  "component:components/chat/WorkLog/WorkLogDetails",
  PluginOriginalWorkLogDetails,
);

const GroupedRows = createPluginContext("components/chat/WorkLog/GroupedRows", false);

/** Groups may span virtualized timeline items. Each part owns its trailing space. */
function PluginOriginalWorkLogBlock({
  layout = "standalone",
  continues = false,
  children,
}: {
  layout?: "standalone" | "group-header" | "group-content";
  continues?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <div
      className={
        continues || layout === "group-header"
          ? "pb-0"
          : layout === "group-content"
            ? "pb-1"
            : "pb-2"
      }
    >
      {children}
    </div>
  );
}

function PluginOriginalWorkLogList({ children }: { children: ReactNode }) {
  return (
    <GroupedRows value>
      <div className="flex min-w-0 flex-col">{children}</div>
    </GroupedRows>
  );
}

type RowContent = {
  icon?: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  wrapLabel?: boolean;
};

const focusRingClassName =
  "rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";

type LineProps = Omit<ComponentProps<"div">, "className" | "style" | "children">;

function PluginOriginalWorkLogLine({
  icon,
  label,
  trailing,
  wrapLabel,
  ...lineProps
}: RowContent & LineProps) {
  return (
    <div
      {...lineProps}
      className={cn(
        "flex min-h-6 min-w-0 gap-1.5 text-sm leading-relaxed select-none [&_*]:select-none",
        wrapLabel ? "items-start" : "items-center",
        lineProps.role === "button" && focusRingClassName,
      )}
    >
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        {icon ? (
          <span className="relative w-6 shrink-0 leading-0">
            <span className="inline-block size-6 overflow-hidden align-[calc(0.5cap_-_0.75rem)]">
              <span className="flex size-full items-center justify-center">{icon}</span>
            </span>
          </span>
        ) : null}
        <div
          className={cn(
            "min-w-0 flex-1 text-secondary-label",
            !wrapLabel && "truncate [&_*]:whitespace-nowrap",
          )}
        >
          {label}
        </div>
      </div>
      {trailing}
    </div>
  );
}

function useRowClassName(interactive: boolean, focusable = interactive) {
  const grouped = use(GroupedRows);
  return cn(
    "group/timeline-row relative w-full min-w-0 rounded-md px-0.5 text-left transition-colors",
    grouped ? "py-0" : "py-0.5",
    interactive && "cursor-pointer",
    focusable && focusRingClassName,
  );
}

function PluginOriginalWorkLogButton({
  icon,
  label,
  trailing,
  wrapLabel = false,
  ...buttonProps
}: RowContent & Omit<ComponentProps<"button">, "className" | "style" | "children">) {
  const className = useRowClassName(true);
  return (
    <button {...buttonProps} type="button" className={className}>
      <WorkLogLine icon={icon} label={label} trailing={trailing} wrapLabel={wrapLabel} />
    </button>
  );
}

type RowProps = Omit<ComponentProps<"div">, "className" | "style"> & {
  toggle?: LineProps | undefined;
};

/**
 * Div disclosure permits selectable detail and nested actions. `toggle` goes on
 * the header line only: assistive tech hides a button's children.
 */
function PluginOriginalWorkLogRow({
  icon,
  label,
  trailing,
  wrapLabel = false,
  toggle,
  children,
  ...rowProps
}: RowContent & RowProps) {
  const className = useRowClassName(rowProps.onClick !== undefined, false);
  const detailsId = useId();
  return (
    <div {...rowProps} className={className}>
      <WorkLogLine
        aria-controls={toggle ? detailsId : undefined}
        {...toggle}
        icon={icon}
        label={label}
        trailing={trailing}
        wrapLabel={wrapLabel}
      />
      {toggle ? <div id={detailsId}>{children}</div> : children}
    </div>
  );
}

const LIVE_EDGE_PX = 4;

function PluginOriginalWorkLogDetails({
  children,
  kind = "text",
  followLive = false,
}: {
  children: ReactNode;
  kind?: "text" | "panel" | "media";

  followLive?: boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const atLiveEdgeRef = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pins the scroller's scrollTop to the bottom after each commit while following live output
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (followLive && atLiveEdgeRef.current && scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  });
  return (
    <div
      ref={scrollerRef}
      onScroll={(event) => {
        const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
        atLiveEdgeRef.current = scrollHeight - scrollTop - clientHeight <= LIVE_EDGE_PX;
      }}
      className={cn(
        "cursor-auto",
        kind === "text"
          ? "ms-7 flex max-h-96 flex-col gap-3 overflow-auto px-0.5 py-1 select-text"
          : kind === "panel"
            ? "mt-0.5 mb-1.5 pb-2"
            : "mt-1",
      )}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}
