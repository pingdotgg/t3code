import type { ReleaseChannel } from "./releases";

export const CHANNEL_STORAGE_KEY = "t3code-channel";
const CHANNEL_EVENT = "t3code:channel";

export function siteChannel(): ReleaseChannel {
  return document.documentElement.dataset.channel === "nightly" ? "nightly" : "stable";
}

/** Applies a channel for this page view only, such as one named in the URL. */
export function showSiteChannel(channel: ReleaseChannel) {
  document.documentElement.dataset.channel = channel;
  document.dispatchEvent(new CustomEvent(CHANNEL_EVENT));
}

export function setSiteChannel(channel: ReleaseChannel) {
  try {
    localStorage.setItem(CHANNEL_STORAGE_KEY, channel);
  } catch {}
  showSiteChannel(channel);
}

export function onSiteChannel(listener: (channel: ReleaseChannel) => void) {
  document.addEventListener(CHANNEL_EVENT, () => listener(siteChannel()));
}
