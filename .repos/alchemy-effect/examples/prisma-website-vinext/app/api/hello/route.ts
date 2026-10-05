export function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("name") ?? "world";
  return Response.json({ name, greeting: process.env.GREETING ?? "hello" });
}
