/**
 * Whether an image from untrusted markdown may load. The CSP lets the page load images from
 * `http://127.0.0.1:*`, where the engine and the dev server answer, so a comment must not be able to
 * point at them. Relative sources resolve to that origin and are refused too.
 */
export function isSafeImageSource(src: string | undefined): boolean {
  if (src === undefined) return false;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  if (url.protocol === "data:") return true;
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return !(
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    /^127\./.test(host) ||
    host === "[::1]" ||
    host === "[::]" ||
    host.startsWith("[::ffff:")
  );
}
