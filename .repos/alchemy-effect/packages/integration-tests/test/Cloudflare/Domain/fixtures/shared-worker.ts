import * as Cloudflare from "@alchemy.run/cloudflare";
import { upgradeWorker } from "./upgrade.ts";

/** Billing and Audit at Domain version 0, neither keeping the data they shared. */
export default class DomainSharedV0Worker extends Cloudflare.Worker<DomainSharedV0Worker>()(
  "DomainSharedWorker",
  { main: import.meta.url },
  upgradeWorker({ version: 0, audit: true }),
) {}
