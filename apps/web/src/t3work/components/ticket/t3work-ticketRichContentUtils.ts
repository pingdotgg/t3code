export function formatTimestamp(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function resolveUrlAgainstBase(url: string, baseUrl?: string): string {
  const trimmed = url.trim();
  if (!trimmed || !baseUrl) return trimmed;

  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return trimmed;
  }
}

export function sanitizeJiraHtml(unsafeHtml: string, baseUrl?: string): string {
  if (typeof window === "undefined") return unsafeHtml;

  const parser = new DOMParser();
  const doc = parser.parseFromString(unsafeHtml, "text/html");

  doc.querySelectorAll("script,style,iframe,object,embed,link,meta").forEach((node) => {
    node.remove();
  });

  doc.querySelectorAll("*").forEach((element) => {
    for (const attr of element.attributes) {
      const name = attr.name.toLowerCase();
      const value = attr.value;

      if (name.startsWith("on")) {
        element.removeAttribute(attr.name);
        continue;
      }

      if ((name === "href" || name === "src") && /^\s*javascript:/i.test(value)) {
        element.removeAttribute(attr.name);
        continue;
      }

      if (name === "href" || name === "src") {
        const resolved = resolveUrlAgainstBase(value, baseUrl);
        if (resolved.length > 0) {
          element.setAttribute(attr.name, resolved);
        }
      }
    }
  });

  return doc.body.innerHTML;
}
