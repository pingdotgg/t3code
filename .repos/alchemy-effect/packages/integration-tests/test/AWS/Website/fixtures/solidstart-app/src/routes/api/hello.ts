/**
 * API route exercised through the streaming Function URL origin. Echoes the
 * `echo` query parameter so a cached response is detectable.
 */
export function GET(event: { request: Request }) {
  const echo = new URL(event.request.url).searchParams.get("echo") ?? "";
  return new Response(`SOLIDSTART_AWS_API_MARKER:${echo}`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
