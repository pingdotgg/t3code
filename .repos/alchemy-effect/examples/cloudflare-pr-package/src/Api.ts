import * as PrPackage from "@alchemy.run/pr-package";
import * as Cloudflare from "alchemy/Cloudflare";

/**
 * The real `@alchemy.run/pr-package` Worker. `PrPackage.handler` wires up the
 * R2 bucket, KV tag index, Secrets Store bearer token, and the PackageStore
 * Durable Object internally — this file is the Worker entry, so it must set
 * `main: import.meta.url`.
 *
 * The handler's bearer-token check is the worker side of the bug fixed in
 * https://github.com/alchemy-run/alchemy/pull/598.
 */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
    url: true,
  },
  PrPackage.handler(),
) {}
