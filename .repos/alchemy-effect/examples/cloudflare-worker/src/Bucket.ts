import * as Cloudflare from "@alchemy.run/cloudflare";

export const Bucket = Cloudflare.R2.Bucket("Bucket", { forceDestroy: true });
