import * as Cloudflare from "alchemy/Cloudflare";

// The upload test leaves objects behind; R2 refuses to delete a non-empty
// bucket, so empty it on destroy (preview stages are disposable).
export const Photos = Cloudflare.R2.Bucket("Photos", { forceDestroy: true });

export const Sessions = Cloudflare.KV.Namespace("Sessions");
