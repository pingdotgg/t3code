import * as Cloudflare from "@/Cloudflare/index.ts";
import { presignWorker } from "./routes.ts";

export const PresignLocalBucket = Cloudflare.R2.Bucket("PresignLocalBucket", {
  forceDestroy: true,
});

/** Presign bindings over a locally-emulated bucket (`alchemy dev`). */
export default class PresignLocalWorker extends Cloudflare.Worker<PresignLocalWorker>()(
  "PresignLocalWorker",
  { main: import.meta.url },
  presignWorker(PresignLocalBucket),
) {}
