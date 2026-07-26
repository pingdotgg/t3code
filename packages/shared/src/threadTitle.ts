const MAX_TITLE_LENGTH = 500;

export const DEFAULT_THREAD_TITLE = "New thread";

export function isDefaultThreadTitle(title: string | null | undefined): boolean {
  return (title ?? "").trim() === DEFAULT_THREAD_TITLE;
}

export function sanitizeTitle(title: string): string {
  return title
    .replace(/./g, (c) => {
      const code = c.charCodeAt(0);
      return code > 0x1f || code === 0x09 || code === 0x0a || code === 0x0d ? c : "";
    })
    .slice(0, MAX_TITLE_LENGTH)
    .trim();
}
