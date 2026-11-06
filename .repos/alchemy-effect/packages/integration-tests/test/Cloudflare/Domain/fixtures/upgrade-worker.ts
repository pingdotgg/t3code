import * as Cloudflare from "@alchemy.run/cloudflare";
import { upgradeWorker } from "./upgrade.ts";

/** Billing, laid out as Domain version 0. */
export default class DomainUpgradeV0Worker extends Cloudflare.Worker<DomainUpgradeV0Worker>()(
  "DomainUpgradeWorker",
  { main: import.meta.url },
  upgradeWorker({ version: 0, audit: false }),
) {}
