import { fail } from "@sveltejs/kit";

// Local Platform shape — see ../+page.server.ts for why `./$types` and the
// global `App` namespace are avoided in this fixture.
interface Platform {
  env?: { TEST_BINDING?: string };
}

/**
 * A named form action. POSTing urlencoded data to `/form?/greet` must reach
 * the worker (the first non-GET against the deployed site), run server-side,
 * and observe `platform.env` — the same platform object loads and endpoints
 * see.
 */
export const actions = {
  greet: async ({
    request,
    platform,
  }: {
    request: Request;
    platform?: Platform;
  }) => {
    const data = await request.formData();
    const name = data.get("name");
    if (typeof name !== "string" || name.length === 0) {
      return fail(400, { error: "name is required" });
    }
    return {
      greeting: `hello ${name}`,
      binding: platform?.env?.TEST_BINDING ?? "no-platform-env",
    };
  },
};
