// App Router route handler: JSON marker + query echo (round-trips through
// the CloudFront edge router's query forwarding).
export function GET(request: Request) {
  const url = new URL(request.url);
  return Response.json({
    marker: "NEXTJS_AWS_API_MARKER",
    echo: url.searchParams.get("echo"),
  });
}
