import { describe, expect, it } from "vite-plus/test";

import { APP_SCHEME } from "./appScheme.ts";
import {
  CLOUDFLARE_ACCESS_APP_CALLBACK_URL,
  cloudflareAccessLoginOrigin,
  readCloudflareAccessAppCallback,
} from "./cloudflareAccessLogin.ts";

describe("cloudflareAccessLoginOrigin", () => {
  it.each([
    ["code.example.com", "https://code.example.com"],
    [" https://code.example.com/pair#token=x ", "https://code.example.com"],
    ["https://code.example.com:8443/", "https://code.example.com:8443"],
    ["http://code.example.com", null],
    ["192.168.1.10:3773", null],
    ["[::1]:3773", null],
    ["localhost:3773", null],
    [`${APP_SCHEME}://pair?pairingUrl=x`, null],
    ["", null],
  ])("%s → %s", (host, origin) => {
    expect(cloudflareAccessLoginOrigin(host)).toBe(origin);
  });
});

describe("readCloudflareAccessAppCallback", () => {
  it.each([
    [`${CLOUDFLARE_ACCESS_APP_CALLBACK_URL}#token=abc`, "abc"],
    [`${CLOUDFLARE_ACCESS_APP_CALLBACK_URL}/#token=abc`, "abc"],
    [`${CLOUDFLARE_ACCESS_APP_CALLBACK_URL}?token=abc`, null],
    [`${CLOUDFLARE_ACCESS_APP_CALLBACK_URL}#token=`, null],
    [`${CLOUDFLARE_ACCESS_APP_CALLBACK_URL}/other#token=abc`, null],
    [`${APP_SCHEME}://pair#token=abc`, null],
    ["forkcode-dev://cloudflare-access#token=abc", "abc"],
    ["https://cloudflare-access/#token=abc", null],
    ["not a url", null],
  ])("%s → %s", (url, token) => {
    expect(readCloudflareAccessAppCallback(url)).toBe(token);
  });
});
