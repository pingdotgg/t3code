import * as Cloudflare from "@alchemy.run/cloudflare";
import { upgradeWorker } from "./upgrade.ts";

/** Billing and Audit sharing Account's class, as before Domain versions existed. */
export default class DomainSharedNoneWorker extends Cloudflare.Worker<DomainSharedNoneWorker>()(
  "DomainSharedWorker",
  { main: import.meta.url },
  upgradeWorker({ version: undefined, audit: true }),
) {}
