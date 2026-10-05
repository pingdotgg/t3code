import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import { presignWorker } from "./routes.ts";

/** A real R2 bucket, even under `alchemy dev`. */
export const PresignRemoteBucket = Cloudflare.R2.Bucket("PresignRemoteBucket", {
  forceDestroy: true,
}).pipe(Alchemy.remote());

/** Presign bindings over a live bucket (deployed or `Alchemy.remote()`). */
export default class PresignRemoteWorker extends Cloudflare.Worker<PresignRemoteWorker>()(
  "PresignRemoteWorker",
  { main: import.meta.url },
  presignWorker(PresignRemoteBucket),
) {}
