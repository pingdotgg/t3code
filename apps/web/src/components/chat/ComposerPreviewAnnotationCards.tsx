import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { MousePointerClick, X } from "lucide-react";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import { formatElementContextLabel, normalizeElementContextSelection } from "~/lib/elementContext";
import { summarizePreviewAnnotationTargets } from "~/lib/previewAnnotation";
import { cn } from "~/lib/utils";

interface ComposerPreviewAnnotationCardsProps {
  annotations: ReadonlyArray<PreviewAnnotationPayload>;
  images: ReadonlyArray<ComposerImageAttachment>;
  onRemove: (annotationId: string) => void;
  onExpandImage: (imageId: string) => void;
  className?: string;
}

export function ComposerPreviewAnnotationCards({
  annotations,
  images,
  onRemove,
  onExpandImage,
  className,
}: ComposerPreviewAnnotationCardsProps) {
  if (annotations.length === 0) return null;
  const imagesById = new Map(images.map((image) => [image.id, image]));

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {annotations.map((annotation) => {
        const image = imagesById.get(annotation.id);
        const elementLabels = annotation.elements.flatMap((target) => {
          const context = normalizeElementContextSelection(target.element);
          return context ? [{ id: target.id, label: formatElementContextLabel(context) }] : [];
        });
        return (
          <section
            key={annotation.id}
            className="group/preview-annotation relative flex min-w-0 max-w-full items-center overflow-hidden rounded-lg border border-border/80 bg-background/72"
          >
            {image?.previewUrl ? (
              <button
                type="button"
                aria-label={`Preview ${image.name}`}
                className="size-14 shrink-0 cursor-zoom-in overflow-hidden border-r border-border/70 bg-muted"
                onClick={() => onExpandImage(image.id)}
              >
                <img
                  src={image.previewUrl}
                  alt="Annotated preview crop"
                  className="size-full object-cover transition duration-200 group-hover/preview-annotation:scale-[1.03]"
                />
              </button>
            ) : (
              <span className="grid size-10 shrink-0 place-items-center border-r border-border/70 text-message-action">
                <MousePointerClick className="size-3.5" />
              </span>
            )}
            <div className="min-w-0 px-2.5 py-2 pr-8">
              <p className="max-w-80 truncate text-foreground text-xs font-medium">
                {annotation.comment.trim() || "Marked on the page"}
              </p>
              <p className="mt-0.5 max-w-80 truncate text-secondary-label text-[10px]">
                {[
                  annotation.pageTitle?.trim() || null,
                  summarizePreviewAnnotationTargets(annotation) || null,
                  elementLabels[0]?.label ?? null,
                ]
                  .filter((part): part is string => part !== null && part.length > 0)
                  .join(" · ")}
              </p>
            </div>
            <button
              type="button"
              aria-label="Remove preview annotation"
              className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded text-icon-muted transition hover:bg-muted hover:text-foreground"
              onClick={() => onRemove(annotation.id)}
            >
              <X className="size-3" />
            </button>
          </section>
        );
      })}
    </div>
  );
}
