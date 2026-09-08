import { counterNamespace } from "../../env.ts";

// Waku API route (served at `/counter`): drives the user's Counter DO via
// the COUNTER namespace binding — the DO class itself is exported by the
// custom worker entry (src/worker-entry.ts).

export const GET = async (): Promise<Response> => {
  const namespace = await counterNamespace();
  if (!namespace) return Response.json({ error: "COUNTER binding missing" }, { status: 500 });
  return Response.json({ count: await namespace.getByName("fixture").get() });
};

export const POST = async (): Promise<Response> => {
  const namespace = await counterNamespace();
  if (!namespace) return Response.json({ error: "COUNTER binding missing" }, { status: 500 });
  return Response.json({ count: await namespace.getByName("fixture").increment() });
};
