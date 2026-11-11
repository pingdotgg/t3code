import * as Cloudflare from "@alchemy.run/cloudflare";
import { upgradeWorker } from "./upgrade.ts";

/** Billing, laid out as before Domain versions existed. */
export default class DomainUpgradeNoneWorker extends Cloudflare.Worker<DomainUpgradeNoneWorker>()(
  "DomainUpgradeWorker",
  { main: import.meta.url },
  upgradeWorker({ version: undefined, audit: false }),
) {}
