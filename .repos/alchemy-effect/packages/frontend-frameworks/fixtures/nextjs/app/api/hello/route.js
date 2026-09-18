export const dynamic = "force-dynamic";

export function GET(request) {
  return Response.json({
    hello: "world",
    url: request.url,
    now: Date.now(),
  });
}
