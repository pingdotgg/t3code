import type { ChatSelectionIndicator, ChatSelectionIndicatorKind } from "~/chatSelectionAnnotation";
import { cn } from "~/lib/utils";

interface IndicatorPresentation {
  readonly label: string;
  readonly className: string;
}

const INDICATOR_PRESENTATION: Record<ChatSelectionIndicatorKind, IndicatorPresentation> = {
  "text-selection": {
    label: "selected text",
    className: "border-blue-400/45 bg-blue-500/90",
  },
  "text-comment": {
    label: "text comment",
    className: "border-blue-400/45 bg-blue-500/90",
  },
};

export function AssistantMessageIndicators({
  placements,
  activeIndicatorId,
  onSelect,
}: {
  placements: ReadonlyArray<{
    indicator: ChatSelectionIndicator;
    top: number;
  }>;
  activeIndicatorId?: string | null;
  onSelect: (indicator: ChatSelectionIndicator, anchorRect: DOMRect) => void;
}) {
  if (placements.length === 0) return null;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 overflow-visible"
      role="group"
      aria-label="Message annotations"
    >
      {placements.map(({ indicator, top }) => {
        const presentation = INDICATOR_PRESENTATION[indicator.kind];
        return (
          <button
            type="button"
            key={indicator.id}
            className={cn(
              "pointer-events-auto absolute inline-flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-background text-[10px] font-semibold leading-none text-white shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              presentation.className,
              activeIndicatorId === indicator.id && "ring-1 ring-blue-300/80",
            )}
            style={{ right: 2, top }}
            aria-label={`Highlight annotation ${indicator.number}: ${presentation.label}`}
            aria-pressed={activeIndicatorId === indicator.id}
            onClick={(event) => onSelect(indicator, event.currentTarget.getBoundingClientRect())}
          >
            {indicator.number}
          </button>
        );
      })}
    </div>
  );
}
