import { fail } from "@sveltejs/kit";
import type { Actions } from "./$types";

export const actions: Actions = {
  greet: async ({ request, platform }) => {
    const data = await request.formData();
    const name = data.get("name");
    if (typeof name !== "string" || name.length === 0) {
      return fail(400, { error: "name is required" });
    }
    return {
      greeting: `hello ${name}`,
      // prove the action sees the same platform as loads/endpoints
      secret: platform?.env?.FIXTURE_SECRET ?? "no-platform-env",
    };
  },
};
