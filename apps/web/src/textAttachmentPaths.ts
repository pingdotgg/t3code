const UUID_PATH_SEGMENT = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TEXT_ATTACHMENT_PATH_PATTERN = new RegExp(
  `(?:^|[\\\\/])(?:\\.t3[\\\\/]attachments|attachments[\\\\/]text)[\\\\/]${UUID_PATH_SEGMENT}[\\\\/]`,
  "i",
);
const LEGACY_FLAT_TEXT_ATTACHMENT_PATH_PATTERN = new RegExp(
  `(?:^|[\\\\/])\\.t3[\\\\/]attachments[\\\\/]${UUID_PATH_SEGMENT}-[^\\\\/]+$`,
  "i",
);

export function isTextAttachmentPath(path: string): boolean {
  return (
    TEXT_ATTACHMENT_PATH_PATTERN.test(path) || LEGACY_FLAT_TEXT_ATTACHMENT_PATH_PATTERN.test(path)
  );
}

export function textAttachmentPaths(prompt: string): string[] {
  return [
    ...new Set(
      collectComposerInlineTokens(prompt).flatMap((token) =>
        token.type === "mention" && isTextAttachmentPath(token.value) ? [token.value] : [],
      ),
    ),
  ];
}

export function removedOwnedTextAttachmentPaths(
  previousPrompt: string,
  nextPrompt: string,
  ownedPaths: ReadonlySet<string>,
): string[] {
  const nextPaths = new Set(textAttachmentPaths(nextPrompt));
  return textAttachmentPaths(previousPrompt).filter(
    (path) => ownedPaths.has(path) && !nextPaths.has(path),
  );
}

import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
