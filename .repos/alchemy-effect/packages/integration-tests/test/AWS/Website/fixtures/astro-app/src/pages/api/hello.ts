import type { APIContext } from "astro";

// On-demand API route: answered by the Lambda through the streaming
// Function URL origin.
export function GET({ url }: APIContext) {
  return Response.json({
    marker: "ASTRO_AWS_API_MARKER",
    echo: url.searchParams.get("echo"),
  });
}
