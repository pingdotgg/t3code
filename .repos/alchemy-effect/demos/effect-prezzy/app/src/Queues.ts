import * as Cloudflare from "@alchemy.run/cloudflare";

/** Background jobs: fetch a link's page and store its preview. */
export const Jobs = Cloudflare.Queues.Queue("Jobs");

export interface UnfurlJob {
  code: string;
  url: string;
}

/** Click events, recorded off the redirect's hot path. */
export const Clicks = Cloudflare.Queues.Queue("Clicks");

export interface ClickEvent {
  code: string;
  at: number;
}
