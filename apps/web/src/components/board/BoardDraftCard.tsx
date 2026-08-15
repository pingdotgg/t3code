import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon, Maximize2Icon, SquarePenIcon, Trash2Icon } from "lucide-react";
import { memo, useCallback, type Ref } from "react";

import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type DraftId,
} from "../../composerDraftStore.ts";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";

export interface BoardDraftCardProps {
  /** Stable identity used by the board and dnd-kit. */
  readonly cardKey: string;
  readonly draftId: DraftId;
  readonly cardRef?: Ref<HTMLDivElement>;
  readonly title?: string | null;
  readonly projectTitle: string;
  readonly workflowLabel: string;
  readonly boardStateLabel: string;
  readonly environmentLabel: string;
  readonly branch?: string | null;
  /** Drafts are draggable only when workflow is the board's mutable axis. */
  readonly draggable?: boolean;
  readonly onExpand: (draftId: DraftId) => void;
  readonly onDiscard: (draftId: DraftId) => void;
}

/**
 * Resolves the compact summary used by both board integration and tests.
 * Empty new-thread placeholders return null and should not be mounted.
 */
export function resolveBoardDraftPreview(
  draft: ComposerThreadDraftState | null | undefined,
): string | null {
  if (draft == null || !composerDraftHasUserContent(draft)) return null;

  const promptPreview = draft.prompt.trim().split("\n", 1)[0]?.trim() ?? "";
  if (promptPreview.length > 0) return promptPreview;

  // `images` mirrors persisted attachments once hydration finishes, so use
  // max rather than sum to avoid counting the same image twice.
  const attachmentCount =
    Math.max(draft.images.length, draft.persistedAttachments.length) +
    draft.terminalContexts.length +
    draft.elementContexts.length +
    draft.previewAnnotations.length +
    draft.reviewComments.length;
  return `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`;
}

/**
 * A draft card is intentionally only a summary. Expanding it hands control
 * back to the board; this component never mounts ChatView. Its narrow draft
 * subscription keeps per-keystroke updates local to this card.
 */
export const BoardDraftCard = memo(function BoardDraftCard(props: BoardDraftCardProps) {
  const {
    boardStateLabel,
    branch,
    cardKey,
    cardRef,
    draftId,
    environmentLabel,
    onDiscard,
    onExpand,
    projectTitle,
    title,
    workflowLabel,
  } = props;
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    id: cardKey,
    disabled: props.draggable !== true,
  });
  const composer = useComposerDraftStore((state) => state.draftsByThreadKey[draftId]);
  const preview = resolveBoardDraftPreview(composer);

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      if (typeof cardRef === "function") {
        cardRef(node);
      } else if (cardRef) {
        cardRef.current = node;
      }
    },
    [cardRef, setNodeRef],
  );
  const handleExpand = useCallback(() => onExpand(draftId), [draftId, onExpand]);
  const handleDiscard = useCallback(() => onDiscard(draftId), [draftId, onDiscard]);

  if (preview === null) return null;

  return (
    <div
      ref={setRefs}
      data-board-card={`draft:${draftId}`}
      data-board-card-key={cardKey}
      data-board-draft-id={draftId}
      role="group"
      aria-label={title?.trim() || "Draft"}
      className="outline-none"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      <article
        className={cn(
          "group/draft-card relative flex min-h-48 flex-col overflow-hidden rounded-lg border border-amber-500/35 bg-[color-mix(in_srgb,var(--card)_96%,var(--color-amber-500))] shadow-sm",
          isDragging && "opacity-60",
        )}
      >
        <header className="flex shrink-0 items-start gap-1.5 border-b border-amber-500/15 px-2 py-1.5">
          {props.draggable ? (
            <button
              type="button"
              {...attributes}
              {...listeners}
              aria-label="Drag draft"
              className="mt-0.5 cursor-grab touch-none rounded p-0.5 text-amber-700/50 hover:bg-amber-500/10 hover:text-amber-800 active:cursor-grabbing dark:text-amber-300/50 dark:hover:text-amber-200 pointer-coarse:p-1.5"
            >
              <GripVerticalIcon className="size-3.5" />
            </button>
          ) : (
            <SquarePenIcon
              aria-hidden
              className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-300"
            />
          )}

          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-medium leading-4" title={title ?? "Draft"}>
              {title?.trim() || "Draft"}
            </p>
            <p
              className="truncate text-[10px] text-muted-foreground/60"
              title={`${environmentLabel}${branch ? ` · ${branch}` : ""}`}
            >
              {environmentLabel}
              {branch ? ` · ${branch}` : ""}
            </p>
          </div>

          <Button
            size="icon-xs"
            variant="ghost"
            onClick={handleDiscard}
            aria-label="Discard draft"
            title="Discard draft"
            className="text-muted-foreground/60 hover:text-destructive"
          >
            <Trash2Icon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={handleExpand}
            aria-label="Open draft"
            title="Open draft"
            className="text-muted-foreground/60 hover:text-foreground"
          >
            <Maximize2Icon className="size-3.5" />
          </Button>
        </header>

        <button
          type="button"
          onClick={handleExpand}
          className="flex min-h-24 flex-1 cursor-pointer items-start bg-transparent px-3 py-3 text-left outline-none hover:bg-amber-500/[0.04] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="line-clamp-5 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
            {preview}
          </span>
        </button>

        <footer className="flex flex-wrap gap-1 border-t border-amber-500/15 px-2 py-2">
          <DimensionBadge dimension="Project" label={projectTitle} />
          <DimensionBadge dimension="Workflow" label={workflowLabel} />
          <DimensionBadge dimension="State" label={boardStateLabel} draft />
        </footer>
      </article>
    </div>
  );
});

function DimensionBadge(props: {
  readonly dimension: "Project" | "Workflow" | "State";
  readonly label: string;
  readonly draft?: boolean;
}) {
  return (
    <Badge
      size="sm"
      variant={props.draft ? "warning" : "outline"}
      title={`${props.dimension}: ${props.label}`}
      className="max-w-full gap-1 font-normal"
    >
      <span className="text-[9px] uppercase tracking-wide opacity-60">{props.dimension}</span>
      <span className="max-w-32 truncate">{props.label}</span>
    </Badge>
  );
}
