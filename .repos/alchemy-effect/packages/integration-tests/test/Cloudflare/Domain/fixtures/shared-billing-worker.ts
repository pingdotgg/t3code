import * as Cloudflare from "@alchemy.run/cloudflare";
import { upgradeWorker } from "./upgrade.ts";

/** Billing and Audit at Domain version 0, Billing keeping the data they shared. */
export default class DomainSharedBillingWorker extends Cloudflare.Worker<DomainSharedBillingWorker>()(
  "DomainSharedWorker",
  { main: import.meta.url },
  upgradeWorker({ version: 0, audit: true, legacyData: "Billing" }),
) {}
