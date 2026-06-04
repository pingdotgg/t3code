import * as AdoptPolicy from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";

export const Zone = Cloudflare.Zone("alchemy-test-2.us", {
  name: "alchemy-test-2.us",
}).pipe(AdoptPolicy.adopt());
