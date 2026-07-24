function isRtlChar(c: number): boolean {
  return (
    (c >= 0x0590 && c <= 0x05ff) ||
    (c >= 0x0600 && c <= 0x06ff) ||
    (c >= 0x0750 && c <= 0x077f) ||
    (c >= 0x08a0 && c <= 0x08ff) ||
    (c >= 0xfb1d && c <= 0xfdff) ||
    (c >= 0xfe70 && c <= 0xfeff)
  );
}

function isLtrChar(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x024f);
}

export function isRtlText(text: string): boolean {
  let rtl = 0;
  let ltr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (isRtlChar(c)) rtl++;
    else if (isLtrChar(c)) ltr++;
  }
  if (rtl === 0 && ltr === 0) return false;
  return rtl > ltr;
}

export function containsRtl(text: string): boolean {
  return Array.from(text).some((char) => isRtlChar(char.charCodeAt(0)));
}

export function dirFor(text: string): "rtl" | "ltr" {
  return isRtlText(text) ? "rtl" : "ltr";
}

const MARKDOWN_DIRECTION_NEUTRAL_RE = /```[\s\S]*?(?:```|$)|`[^`\n]*`|https?:\/\/\S+/g;

export function dirForMarkdown(text: string): "rtl" | "ltr" {
  return dirFor(text.replace(MARKDOWN_DIRECTION_NEUTRAL_RE, ""));
}
