// App Router route handler. The middleware matcher covers /api/*, so the
// test also asserts the x-fixture-middleware pass-through header here.
export function GET() {
  return Response.json({ hello: "world" });
}
