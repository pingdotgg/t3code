import * as Cloudflare from "alchemy/Cloudflare";

export const Uploads = Cloudflare.R2.Bucket("Uploads", {
  forceDestroy: true,
});
