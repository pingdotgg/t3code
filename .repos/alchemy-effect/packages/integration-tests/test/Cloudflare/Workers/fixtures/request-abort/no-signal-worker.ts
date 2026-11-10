import * as Cloudflare from "@alchemy.run/cloudflare";
import { requestAbortHandler } from "./shared.ts";

/** The same Worker without `enable_request_signal`. */
export default class NoSignalWorker extends Cloudflare.Worker<NoSignalWorker>()(
  "RequestAbortNoSignalWorker",
  { main: import.meta.url },
  requestAbortHandler,
) {}
