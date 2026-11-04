/**
 * Resource route (no default export) exercised through the streaming
 * Function URL origin. Echoes the `echo` query parameter so a cached
 * response is detectable.
 */
export function loader({ request }: { request: Request }) {
  const echo = new URL(request.url).searchParams.get("echo") ?? "";
  return new Response(`REACT_ROUTER_AWS_API_MARKER:${echo}`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
