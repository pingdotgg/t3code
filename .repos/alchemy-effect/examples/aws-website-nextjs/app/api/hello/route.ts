// App Router route handler — the integ test asserts this JSON shape.
export function GET() {
  return Response.json({ hello: "world" });
}
