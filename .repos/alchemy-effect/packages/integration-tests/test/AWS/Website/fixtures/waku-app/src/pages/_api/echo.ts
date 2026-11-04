// Waku's API-route pattern: files under `pages/_api/` export HTTP-method
// handlers and are served with the `_api` prefix stripped (this file answers
// `/echo`). Handlers run in the Lambda like every other dynamic route.

export const GET = async (request: Request): Promise<Response> => {
  const echo = new URL(request.url).searchParams.get("echo") ?? "";
  return Response.json({ marker: "WAKU_AWS_API_MARKER", echo });
};

export const POST = async (request: Request): Promise<Response> => {
  const body = (await request.json()) as Record<string, unknown>;
  return Response.json({ marker: "WAKU_AWS_API_MARKER", echoed: body });
};
