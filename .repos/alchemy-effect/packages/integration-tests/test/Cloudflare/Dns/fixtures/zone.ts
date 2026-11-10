import * as Cloudflare from "@alchemy.run/cloudflare";
import * as AdoptPolicy from "alchemy/AdoptPolicy";

export const Zone = Cloudflare.Zone.Zone("alchemy-test-2.us", {
  name: "alchemy-test-2.us",
}).pipe(AdoptPolicy.adopt());
