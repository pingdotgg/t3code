import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { Frame, MousePointerClick, Paintbrush, PenLine, X } from "lucide-react";
import type { ReactNode } from "react";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import { formatElementContextLabel, normalizeElementContextSelection } from "~/lib/elementContext";
import { cn } from "~/lib/utils";
import { useI18n, type MessageKey } from "~/i18n";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ComposerPreviewAnnotationCardsProps {
  annotations: ReadonlyArray<PreviewAnnotationPayload>;
  images: ReadonlyArray<ComposerImageAttachment>;
  onRemove: (annotationId: string) => void;
  onExpandImage: (imageId: string) => void;
  className?: string;
}

function TargetStat(props: {
  icon: ReactNode;
  count: number;
  singularKey: MessageKey;
  pluralKey: MessageKey;
}) {
  const { t } = useI18n();
  const tooltipText = `${props.count} ${t(props.count === 1 ? props.singularKey : props.pluralKey)}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
            {props.icon}
            {props.count}
          </span>
        }
      />
      <TooltipPopup side="top">{tooltipText}</TooltipPopup>
    </Tooltip>
  );
}

export function ComposerPreviewAnnotationCards({
  annotations,
  images,
  onRemove,
  onExpandImage,
  className,
}: ComposerPreviewAnnotationCardsProps) {
  const { t } = useI18n();
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
                aria-label={t("chat.image.previewNamed", { name: image.name })}
                className="size-14 shrink-0 cursor-zoom-in overflow-hidden border-r border-border/70 bg-muted"
                onClick={() => onExpandImage(image.id)}
              >
                <img
                  src={image.previewUrl}
                  alt={t("chat.image.annotatedCrop")}
                  className="size-full object-cover transition duration-200 group-hover/preview-annotation:scale-[1.03]"
                />
              </button>
            ) : (
              <span className="grid size-10 shrink-0 place-items-center border-r border-border/70 text-message-action">
                <MousePointerClick className="size-3.5" />
              </span>
            )}
            <div className="min-w-0 px-2.5 py-2 pr-8">
              {annotation.comment.trim() ? (
                <p className="max-w-80 truncate text-foreground text-xs font-medium">
                  {annotation.comment.trim()}
                </p>
              ) : null}
              <div
                className={cn(
                  "flex min-w-0 items-center gap-2",
                  annotation.comment.trim() && "mt-1",
                )}
              >
                {elementLabels.length > 0 ? (
                  <div className="flex min-w-0 items-center gap-1">
                    {elementLabels.slice(0, 2).map(({ id, label }) => (
                      <span
                        key={id}
                        className="max-w-40 truncate font-mono text-secondary-label text-[10px]"
                      >
                        {label}
                      </span>
                    ))}
                    {elementLabels.length > 2 ? (
                      <span className="text-secondary-label text-[10px]">
                        +{elementLabels.length - 2}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <div className="flex shrink-0 items-center gap-2">
                  {annotation.elements.length > 0 ? (
                    <TargetStat
                      icon={<MousePointerClick className="size-3" />}
                      count={annotation.elements.length}
                      singularKey="chat.preview.element"
                      pluralKey="chat.preview.elements"
                    />
                  ) : null}
                  {annotation.regions.length > 0 ? (
                    <TargetStat
                      icon={<Frame className="size-3" />}
                      count={annotation.regions.length}
                      singularKey="chat.preview.region"
                      pluralKey="chat.preview.regions"
                    />
                  ) : null}
                  {annotation.strokes.length > 0 ? (
                    <TargetStat
                      icon={<PenLine className="size-3" />}
                      count={annotation.strokes.length}
                      singularKey="chat.preview.drawing"
                      pluralKey="chat.preview.drawings"
                    />
                  ) : null}
                  {annotation.styleChanges.length > 0 ? (
                    <TargetStat
                      icon={<Paintbrush className="size-3" />}
                      count={annotation.styleChanges.length}
                      singularKey="chat.preview.styleChange"
                      pluralKey="chat.preview.styleChanges"
                    />
                  ) : null}
                </div>
              </div>
            </div>
            <Button
              size="icon-micro"
              variant="ghost-muted"
              aria-label={t("chat.preview.removeAnnotation")}
              className="absolute right-1.5 top-1.5 [--control-icon-color:currentColor] rounded text-icon-muted hover:bg-muted"
              onClick={() => onRemove(annotation.id)}
            >
              <X className="size-3" />
            </Button>
          </section>
        );
      })}
    </div>
  );
}
