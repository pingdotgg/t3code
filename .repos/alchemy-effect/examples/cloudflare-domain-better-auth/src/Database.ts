import * as Cloudflare from "@alchemy.run/cloudflare";

/** better-auth's users, accounts and sessions. */
export const AuthDb = Cloudflare.D1.Database("AuthDb");
