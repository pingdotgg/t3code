export const dynamic = "force-dynamic";

// One id per server process, so a test can tell environments apart.
const instance = crypto.randomUUID();

export function GET() {
  return Response.json({ instance });
}
