import { json } from "@sveltejs/kit";
import { stringifySetCookie } from "cookie";
import { randomUUID } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ platform }) => {
  return json({
    // `uuid` has browser/node conditional exports — the workerd re-bundle must
    // pick an entry that works under workerd.
    uuid: uuidv4(),
    // direct node builtin usage — exercises nodejs_compat externalization
    nodeUuid: randomUUID(),
    // `cookie` v2 — plain conditional-exports dependency
    cookie: stringifySetCookie({ name: "fixture", value: "ok" }),
    secret: platform?.env?.FIXTURE_SECRET ?? "no-platform-env",
  });
};
