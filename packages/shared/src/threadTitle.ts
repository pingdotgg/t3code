const MAX_TITLE_LENGTH = 500;

export const DEFAULT_THREAD_TITLE = "New thread";

export function isDefaultThreadTitle(title: string | null | undefined): boolean {
  return (title ?? "").trim() === DEFAULT_THREAD_TITLE;
}

export function sanitizeTitle(title: string): string {
  return title
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .slice(0, MAX_TITLE_LENGTH)
    .trim();
}
