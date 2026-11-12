import * as Cloudflare from "@alchemy.run/cloudflare";

/** Click events, counted off the redirect's hot path. */
export const Clicks = Cloudflare.Queues.Queue("Clicks");

export interface ClickEvent {
  code: string;
  at: string;
}
