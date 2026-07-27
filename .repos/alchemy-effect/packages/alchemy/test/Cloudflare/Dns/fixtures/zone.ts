import * as AdoptPolicy from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";

export const Zone = Cloudflare.Zone.Zone("alchemy-test-2.us", {
  name: "alchemy-test-2.us",
}).pipe(AdoptPolicy.adopt());
