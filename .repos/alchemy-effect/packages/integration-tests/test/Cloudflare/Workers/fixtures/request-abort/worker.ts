import * as Cloudflare from "@alchemy.run/cloudflare";
import { requestAbortHandler } from "./shared.ts";

export default class RequestAbortWorker extends Cloudflare.Worker<RequestAbortWorker>()(
  "RequestAbortWorker",
  {
    main: import.meta.url,
    // Workers only fire `request.signal` when the client disconnects under
    // this flag.
    compatibility: { flags: ["enable_request_signal"] },
  },
  requestAbortHandler,
) {}
