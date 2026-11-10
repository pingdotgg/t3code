import {
  COMPOSER_CONTEXT_KINDS,
  type ChatAttachment,
  type EnvironmentId,
  type KnownComposerContextKind,
  type PipelineRunContextChip,
} from "@t3tools/contracts";

import { useAssetUrls } from "../../assets/assetUrls";
import { selectMessageImageResources } from "../../session-logic";
import { type ChatFileAttachment, isFileAttachment, isImageAttachment } from "../../types";
import { ContextChip, ContextChipLabel, type ContextChipKind } from "../ContextChip";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import { GuestMessageAttachments } from "./GuestMessageAttachments";

const isKnownContextKind = (kind: string): kind is KnownComposerContextKind =>
  (COMPOSER_CONTEXT_KINDS as ReadonlyArray<string>).includes(kind);

/** Every known context kind has a chip colour of the same name. */
const chipKind = (kind: string): ContextChipKind => (isKnownContextKind(kind) ? kind : "neutral");

/** The images, files and context that came with a run's starting prompt. */
export function PipelineStartAttachments(props: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly contextChips: ReadonlyArray<PipelineRunContextChip>;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
  readonly onFileOpen: (attachment: ChatFileAttachment) => void;
}) {
  // An annotation's screenshot belongs to its annotation chip, as in a user message.
  const shown = props.attachments.filter(
    (attachment) =>
      isFileAttachment(attachment) ||
      (isImageAttachment(attachment) && !attachment.name.startsWith("preview-annotation-")),
  );
  const images = shown.filter(isImageAttachment);
  const resources = selectMessageImageResources(images);
  const urls = useAssetUrls(props.environmentId, resources);
  const urlsById = new Map(
    resources.flatMap((resource, index) => {
      const url = urls[index];
      return url ? [[resource.attachmentId, url] as const] : [];
    }),
  );
  // Image and file chips only bind the attachments shown above.
  const chips = props.contextChips.filter((chip) => chip.kind !== "image" && chip.kind !== "file");
  if (shown.length + chips.length === 0) return null;
  return (
    <div className="flex flex-col items-end gap-1.5">
      <GuestMessageAttachments
        attachments={shown}
        imageUrl={(attachment) => urlsById.get(attachment.id)}
        onOpenImage={(attachment) => {
          const preview = buildExpandedImagePreview(
            images.map((image) => ({ ...image, previewUrl: urlsById.get(image.id) ?? "" })),
            attachment.id,
          );
          if (preview) props.onImageExpand(preview);
        }}
        onOpenFile={props.onFileOpen}
      />
      {chips.length > 0 ? (
        <div className="flex flex-wrap justify-end gap-1.5">
          {chips.map((chip) => (
            <ContextChip key={chip.contextId} kind={chipKind(chip.kind)} shape="inline">
              <ContextChipLabel>{chip.label}</ContextChipLabel>
            </ContextChip>
          ))}
        </div>
      ) : null}
    </div>
  );
}
