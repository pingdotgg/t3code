import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";

import type { CONTEXT_CHIP_ICON_SOURCES } from "./contextChipIcons.generated";

export type ContextChipIcon = keyof typeof CONTEXT_CHIP_ICON_SOURCES;

interface ContextChipPresentation {
  readonly accent?: string;
  readonly symbol: string;
  readonly icon: ContextChipIcon | null;
}

/**
 * These are the sRGB form of the same OKLCH set web uses, so a chip looks the same on every
 * surface. See `ContextChip.tsx`.
 */
const CONTEXT_CHIP_PRESENTATIONS = {
  image: { accent: "#d55665", symbol: "photo", icon: "image" },
  video: { accent: "#d06217", symbol: "play.rectangle", icon: "film" },
  file: { accent: "#0090cd", symbol: "doc", icon: null },
  mention: { accent: "#0096af", symbol: "doc", icon: null },
  terminal: { accent: "#009f6e", symbol: "terminal", icon: "terminal" },
  element: { accent: "#b87501", symbol: "cursorarrow.click", icon: "mouse-pointer-click" },
  "preview-annotation": {
    accent: "#b87501",
    symbol: "cursorarrow.click",
    icon: "mouse-pointer-click",
  },
  "review-comment": { accent: "#8a70dd", symbol: "text.bubble", icon: "message-circle" },
  "pull-request": {
    accent: "#7079e4",
    symbol: "git-pull-request",
    icon: "git-pull-request-arrow",
  },
  skill: { accent: "#b261be", symbol: "cube", icon: "skill" },
  thread: {
    accent: "#009c96",
    symbol: "bubble.left.and.bubble.right",
    icon: "messages-square",
  },
} as const satisfies Record<string, ContextChipPresentation>;

export const UNAVAILABLE_CONTEXT_CHIP_PRESENTATION: ContextChipPresentation = {
  symbol: "doc",
  icon: "circle-dashed",
};

export function composerChipSizeSuffix(record?: {
  readonly kind?: string;
  readonly sizeBytes?: number;
}): string {
  if (record?.kind !== "file" && record?.kind !== "image") return "";
  return typeof record.sizeBytes === "number" ? formatAttachmentSize(record.sizeBytes) : "";
}

const PULL_REQUEST_CHIP_PRESENTATIONS = {
  open: { accent: "#009f6e", symbol: "git-pull-request", icon: "git-pull-request-arrow" },
  draft: { accent: "#7f8793", symbol: "git-pull-request", icon: "git-pull-request-draft" },
  merged: { accent: "#8a70dd", symbol: "git-pull-request", icon: "git-merge" },
  closed: { accent: "#d55665", symbol: "git-pull-request", icon: "git-pull-request-closed" },
} as const satisfies Record<string, ContextChipPresentation>;

export function contextChipPresentation(
  kind: string,
  record?: {
    readonly kind?: string;
    readonly name?: string;
    readonly mimeType?: string;
    readonly sectionId?: string;
    readonly pullRequest?: {
      readonly state?: string;
      readonly isDraft?: boolean;
    };
  },
): ContextChipPresentation {
  const presentationKind =
    kind === "file" &&
    videoMimeType({
      name: record?.name ?? "",
      mimeType: record?.mimeType ?? "",
    })
      ? "video"
      : kind === "file" &&
          imageMimeType({ name: record?.name ?? "", mimeType: record?.mimeType ?? "" }) !== null
        ? "image"
        : kind === "review-comment" && record?.sectionId?.startsWith("pull-request:")
          ? "pull-request"
          : kind;
  if (presentationKind === "pull-request") {
    const pullRequest = record?.pullRequest;
    const state =
      pullRequest?.state === "open" && pullRequest.isDraft === true
        ? "draft"
        : (pullRequest?.state ?? "");
    if (Object.hasOwn(PULL_REQUEST_CHIP_PRESENTATIONS, state)) {
      return PULL_REQUEST_CHIP_PRESENTATIONS[state as keyof typeof PULL_REQUEST_CHIP_PRESENTATIONS];
    }
  }
  return Object.hasOwn(CONTEXT_CHIP_PRESENTATIONS, presentationKind)
    ? CONTEXT_CHIP_PRESENTATIONS[presentationKind as keyof typeof CONTEXT_CHIP_PRESENTATIONS]
    : UNAVAILABLE_CONTEXT_CHIP_PRESENTATION;
}
