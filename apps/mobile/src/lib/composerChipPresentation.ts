import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { imageMimeType } from "@t3tools/shared/image";
import { linearIssueExtrasSummary } from "@t3tools/shared/linearLaunch";
import { videoMimeType } from "@t3tools/shared/video";

import type { CONTEXT_CHIP_ICON_SOURCES } from "./contextChipIcons.generated";
import { resolveMarkdownFileIcon, type MarkdownFileIcon } from "./markdownLinks";
import {
  flattenThemeColor,
  isDarkThemeColor,
  themeAccentWithContrast,
  type MobileThemeVariables,
} from "./mobileTheme";

export type ContextChipIcon = keyof typeof CONTEXT_CHIP_ICON_SOURCES;

interface ContextChipPresentation {
  readonly accent?: string;
  readonly icon: ContextChipIcon | null;
}

/**
 * These are the sRGB form of the same OKLCH set web uses, so a chip looks the same on every
 * surface. See `ContextChip.tsx`.
 */
const CONTEXT_CHIP_PRESENTATIONS = {
  image: { accent: "#0090cd", icon: "image" },
  video: { accent: "#d06217", icon: "film" },
  file: { accent: "#0090cd", icon: null },
  mention: { accent: "#0096af", icon: null },
  terminal: { accent: "#009f6e", icon: "terminal" },
  element: { accent: "#b87501", icon: "mouse-pointer-click" },
  "preview-annotation": {
    accent: "#b87501",
    icon: "mouse-pointer-click",
  },
  "review-comment": { accent: "#8a70dd", icon: "message-circle" },
  "pull-request": {
    accent: "#7079e4",
    icon: "git-pull-request-arrow",
  },
  skill: { accent: "#b261be", icon: "skill" },
  thread: {
    accent: "#009c96",
    icon: "messages-square",
  },
  // A machine: the record carries only its identity, so every machine wears one glyph.
  environment: { accent: "#3f9a4f", icon: "server" },
  "linear-issue": { accent: "#7079e4", icon: "linear" },
} as const satisfies Record<string, ContextChipPresentation>;

const CHIP_CONTRAST = 5;

const readableChipAccents = new Map<string, string>();

/**
 * A chip keeps one color per theme so it looks the same in a message, a reply and the composer,
 * which means it must read on all of them; the user bubble is usually the hardest. A surface
 * whose text is the opposite shade, like Material You's primary-colored light bubble, can't share
 * a color with the canvas, so chips are matched only against surfaces like the one they sit on.
 */
export function contextChipAccent(
  accent: string | undefined,
  theme: MobileThemeVariables,
  textColor: string,
): string | undefined {
  if (!accent) return undefined;
  const screen = theme["--color-screen"];
  const darkText = isDarkThemeColor(textColor);
  const surfaces = (
    [
      ["--color-user-bubble", "--color-user-bubble-foreground"],
      ["--color-thread-canvas", "--color-md-body"],
      ["--color-composer-surface", "--color-foreground"],
    ] as const
  )
    .filter(([, text]) => isDarkThemeColor(theme[text]) === darkText)
    .map(([surface]) => flattenThemeColor(theme[surface], screen));
  const key = [accent, ...surfaces].join();
  let readable = readableChipAccents.get(key);
  if (readable === undefined) {
    readable = themeAccentWithContrast(accent, surfaces, CHIP_CONTRAST);
    readableChipAccents.set(key, readable);
  }
  return readable;
}

export const UNAVAILABLE_CONTEXT_CHIP_PRESENTATION: ContextChipPresentation = {
  icon: "circle-dashed",
};

export function composerChipSizeSuffix(record?: {
  readonly kind?: string;
  readonly sizeBytes?: number;
  readonly subIssues?: ReadonlyArray<unknown>;
  readonly comments?: ReadonlyArray<unknown>;
}): string {
  if (record?.kind === "linear-issue") {
    return (
      linearIssueExtrasSummary({
        subIssues: record.subIssues ?? [],
        comments: record.comments ?? [],
      }) ?? ""
    );
  }
  if (record?.kind !== "file" && record?.kind !== "image") return "";
  return typeof record.sizeBytes === "number" ? formatAttachmentSize(record.sizeBytes) : "";
}

const PULL_REQUEST_CHIP_PRESENTATIONS = {
  open: { accent: "#009f6e", icon: "git-pull-request-arrow" },
  draft: { accent: "#7f8793", icon: "git-pull-request-draft" },
  merged: { accent: "#8a70dd", icon: "git-merge" },
  closed: { accent: "#d55665", icon: "git-pull-request-closed" },
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

export type ContextChipIconRef =
  | { readonly kind: "chip"; readonly name: ContextChipIcon }
  | { readonly kind: "file"; readonly name: MarkdownFileIcon };

export function contextChipIcon(
  presentation: Pick<ContextChipPresentation, "icon">,
  fileName: string,
): ContextChipIconRef {
  return presentation.icon
    ? { kind: "chip", name: presentation.icon }
    : { kind: "file", name: resolveMarkdownFileIcon(fileName) };
}

export function contextRecordFileName(record?: object): string {
  if (record && "path" in record && typeof record.path === "string") return record.path;
  if (record && "name" in record && typeof record.name === "string") return record.name;
  return "";
}
