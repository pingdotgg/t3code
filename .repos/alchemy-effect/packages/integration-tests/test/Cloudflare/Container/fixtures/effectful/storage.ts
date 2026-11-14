import * as Cloudflare from "@alchemy.run/cloudflare";

export const Storage = Cloudflare.R2.Bucket("Storage", { forceDestroy: true });
