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
