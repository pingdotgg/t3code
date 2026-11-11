import type { Handle } from "@sveltejs/kit/hooks";
import { accepting } from "./routes/api/deployment/[operation]/state.ts";

export const handle: Handle = ({ event, resolve }) =>
  accepting() ? resolve(event) : new Response("stopping", { status: 503 });
