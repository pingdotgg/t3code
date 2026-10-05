export function GET(request: Request) {
  return Response.json({
    name: new URL(request.url).searchParams.get("name") ?? "visitor",
    greeting: process.env.GREETING ?? "Hello!",
  });
}
