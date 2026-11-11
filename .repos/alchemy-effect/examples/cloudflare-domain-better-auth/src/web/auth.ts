import { createAuthClient } from "better-auth/client";

/** better-auth's browser client, on the app's own origin. */
export const auth = createAuthClient();
