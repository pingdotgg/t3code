import * as Cloudflare from "@alchemy.run/cloudflare";
import { upgradeWorker } from "./upgrade.ts";

/** Billing at Domain version 0, from a new bundle: a later code change to the same Worker. */
export default class DomainUpgradeNextWorker extends Cloudflare.Worker<DomainUpgradeNextWorker>()(
  "DomainUpgradeWorker",
  { main: import.meta.url },
  upgradeWorker({ version: 0, audit: false }),
) {}
