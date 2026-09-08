import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const PROVIDER_SEND_TURN_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
const PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPE_SET = new Set<string>(
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
);

/** Whether a pasted or picked image mime type can be sent on a provider turn. */
export function isProviderSendTurnSupportedImageMimeType(mimeType: string): boolean {
  return PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPE_SET.has(mimeType.toLowerCase());
}
const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;

export const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS = 32_000;
export const SNAP_SHOT_ACCESSIBILITY_MAX_NODES = 10_000;
export const SNAP_SHOT_ACCESSIBILITY_MAX_SERIALIZED_CHARS = 32_000;

const SnapShotAccessibilityBounds = Schema.Struct({
  x: NonNegativeInt,
  y: NonNegativeInt,
  width: PositiveInt,
  height: PositiveInt,
});

const SnapShotAccessibilityState = Schema.Struct({
  active: Schema.optional(Schema.Boolean),
  busy: Schema.optional(Schema.Boolean),
  checked: Schema.optional(Schema.Literals(["on", "off", "mixed"])),
  editable: Schema.optional(Schema.Boolean),
  enabled: Schema.optional(Schema.Boolean),
  expanded: Schema.optional(Schema.Boolean),
  focused: Schema.optional(Schema.Boolean),
  selected: Schema.optional(Schema.Boolean),
  visible: Schema.optional(Schema.Boolean),
});

export interface SnapShotAccessibilityNode {
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly description?: string;
  readonly bounds: typeof SnapShotAccessibilityBounds.Type | null;
  readonly state?: typeof SnapShotAccessibilityState.Type;
  readonly actions?: Array<string>;
  readonly children: Array<SnapShotAccessibilityNode>;
}

export const SnapShotAccessibilityNode: Schema.Codec<SnapShotAccessibilityNode> = Schema.Struct({
  role: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  name: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(1_000))),
  value: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(8_000))),
  description: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
  bounds: Schema.NullOr(SnapShotAccessibilityBounds),
  state: Schema.optionalKey(SnapShotAccessibilityState),
  actions: Schema.optionalKey(
    Schema.mutable(Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(100)))).check(
      Schema.isMaxLength(32),
    ),
  ),
  children: Schema.mutable(
    Schema.Array(
      Schema.suspend((): Schema.Codec<SnapShotAccessibilityNode> => SnapShotAccessibilityNode),
    ),
  ).check(Schema.isMaxLength(SNAP_SHOT_ACCESSIBILITY_MAX_NODES)),
});

const SnapShotAccessibilityWire = Schema.Union([
  Schema.Struct({
    format: Schema.Literal("flat-text"),
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS)),
    truncated: Schema.Boolean,
  }),
  Schema.Struct({
    format: Schema.Literal("element-tree"),
    coordinateSpace: Schema.Literal("captured-image"),
    imageSize: Schema.Struct({ width: PositiveInt, height: PositiveInt }),
    truncated: Schema.Boolean,
    root: SnapShotAccessibilityNode,
  }),
]);

export const SnapShotAccessibility = SnapShotAccessibilityWire.check(
  Schema.makeFilter((accessibility: typeof SnapShotAccessibilityWire.Type) => {
    if (accessibility.format === "flat-text") return undefined;
    let nodes = 0;
    const stack = [accessibility.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      nodes += 1;
      if (nodes > SNAP_SHOT_ACCESSIBILITY_MAX_NODES) {
        return `Accessibility trees must not exceed ${SNAP_SHOT_ACCESSIBILITY_MAX_NODES} nodes.`;
      }
      stack.push(...node.children);
    }
    return (
      JSON.stringify(accessibility).length <= SNAP_SHOT_ACCESSIBILITY_MAX_SERIALIZED_CHARS ||
      `Accessibility trees must not exceed ${SNAP_SHOT_ACCESSIBILITY_MAX_SERIALIZED_CHARS} serialized characters.`
    );
  }),
);
export type SnapShotAccessibility = typeof SnapShotAccessibility.Type;

export const SnapShotSource = Schema.Struct({
  kind: Schema.Literal("snap-shot"),
  capturedAt: IsoDateTime,
  appName: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  windowTitle: TrimmedString.check(Schema.isMaxLength(1_000)),
  accessibleText: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS)),
  ),
  accessibility: Schema.optional(SnapShotAccessibility),
  appIdentifier: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
  appIconDataUrl: Schema.optional(
    TrimmedNonEmptyString.check(
      Schema.isMaxLength(100_000),
      Schema.isPattern(/^data:image\/png;base64,/i),
    ),
  ),
});
export type SnapShotSource = typeof SnapShotSource.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  source: Schema.optional(SnapShotSource),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

export const ChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES),
  ),
});
export type ChatFileAttachment = typeof ChatFileAttachment.Type;

/**
 * Catch-all for attachment types this build does not know. Attachments ride on
 * persisted events and thread streams, so a newer server or client must be able
 * to introduce a type without making older readers fail to decode the whole
 * message. Decoders keep the shared base fields; consumers skip these or render
 * them as unsupported. Mirrors how `OrchestrationThreadActivity` keeps `kind`
 * open. The known discriminators are excluded so a malformed image or file
 * attachment fails its own schema instead of sliding through here with its
 * size and mime constraints unchecked.
 */
export const ChatUnknownAttachment = Schema.Struct({
  type: TrimmedNonEmptyString.check(
    Schema.isMaxLength(50),
    Schema.isPattern(/^(?!(?:image|file)$)/),
  ),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt,
});
export type ChatUnknownAttachment = typeof ChatUnknownAttachment.Type;

export const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
  source: Schema.optional(SnapShotSource),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

export const ChatAttachment = Schema.Union([
  ChatImageAttachment,
  ChatFileAttachment,
  ChatUnknownAttachment,
]);
export type ChatAttachment = typeof ChatAttachment.Type;

export const UploadChatAttachment = Schema.Union([UploadChatImageAttachment]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;

export const PersistChatAttachmentsInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  attachments: Schema.Array(UploadChatAttachment),
});
export type PersistChatAttachmentsInput = typeof PersistChatAttachmentsInput.Type;

export const PersistChatAttachmentsResult = Schema.Struct({
  attachments: Schema.Array(ChatAttachment),
});
export type PersistChatAttachmentsResult = typeof PersistChatAttachmentsResult.Type;

export class PersistChatAttachmentsError extends Schema.TaggedError<PersistChatAttachmentsError>()(
  "PersistChatAttachmentsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
