import { matchers, routes, type VercelConfig } from "@vercel/config/v1";

const ROUTER_HOST = "app.t3.codes";
const HOSTED_WEB_CHANNEL_COOKIE = "t3code_web_channel";
const LATEST_ORIGIN = "https://latest.app.t3.codes";
const NIGHTLY_ORIGIN = "https://nightly.app.t3.codes";

function channelCookie(channel: "latest" | "nightly"): string {
  return [
    `${HOSTED_WEB_CHANNEL_COOKIE}=${channel}`,
    "Path=/",
    "Max-Age=31536000",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export const config: VercelConfig = {
  buildCommand:
    "turbo build --filter @t3tools/web && bun ../../scripts/apply-web-brand-assets.ts production",
  git: {
    deploymentEnabled: false,
  },
  installCommand:
    "bun add -g turbo && bun install --filter '@t3tools/contracts' --filter '@t3tools/client-runtime' --filter '@t3tools/scripts' --filter '@t3tools/web'",
  routes: [
    {
      src: "/__t3code/channel",
      has: [matchers.query("channel", "nightly")],
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("nightly"),
      },
      status: 302,
    },
    {
      src: "/__t3code/channel",
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("latest"),
      },
      status: 302,
    },
    {
      src: "/(.*)",
      has: [matchers.host(ROUTER_HOST), matchers.cookie(HOSTED_WEB_CHANNEL_COOKIE, "nightly")],
      dest: `${NIGHTLY_ORIGIN}/$1`,
    },
    {
      src: "/(.*)",
      has: [matchers.host(ROUTER_HOST)],
      dest: `${LATEST_ORIGIN}/$1`,
    },
  ],
  rewrites: [routes.rewrite("/(.*)", "/index.html")],
};
