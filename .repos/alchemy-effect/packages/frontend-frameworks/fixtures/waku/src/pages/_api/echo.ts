import { readMessage } from "../../env.ts";

// Waku's API-route pattern: files under `pages/_api/` export HTTP-method
// handlers and are served with the `_api` prefix stripped (this file answers
// `/echo`). Handlers run in the worker like every other dynamic route.

export const GET = async (): Promise<Response> => Response.json({ message: await readMessage() });

export const POST = async (request: Request): Promise<Response> => {
  const body = (await request.json()) as Record<string, unknown>;
  return Response.json({ echoed: body, message: await readMessage() });
};
