import { json } from "@sveltejs/kit";
import { randomUUID } from "node:crypto";

// Local Platform shape — see +page.server.ts.
interface Platform {
  env?: { TEST_BINDING?: string };
}

export const GET = ({ platform }: { platform?: Platform }) => {
  return json({
    // direct node builtin usage — exercises nodejs_compat in the
    // workerd re-bundle pass
    uuid: randomUUID(),
    binding: platform?.env?.TEST_BINDING ?? "no-platform-env",
  });
};
