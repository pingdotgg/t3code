import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  git: {
    deploymentEnabled: false,
  },
  installCommand: "npm install -g vite-plus && vp install --filter '@t3tools/marketing...'",
  buildCommand: "vp run --filter @t3tools/marketing build",
  outputDirectory: "dist",
  // One URL per page: `/download/` and `/download` both served 200 before, which splits ranking signals.
  trailingSlash: false,
  // curl | sh requires plain, uncompressed scripts with no cache across deploys.
  headers: [
    {
      source: "/install.sh",
      headers: [
        { key: "Content-Type", value: "text/x-shellscript; charset=utf-8" },
        { key: "Cache-Control", value: "public, max-age=300" },
      ],
    },
    {
      source: "/install.ps1",
      headers: [
        { key: "Content-Type", value: "text/plain; charset=utf-8" },
        { key: "Cache-Control", value: "public, max-age=300" },
      ],
    },
  ],
  redirects: [
    {
      source: "/app",
      destination: "https://app.t3.codes",
      permanent: true,
    },
    // One QR code in the desktop app serves both stores. iPadOS reports a Mac, so it gets /download.
    {
      source: "/mobile",
      has: [{ type: "header", key: "user-agent", value: ".*(iPhone|iPad|iPod).*" }],
      destination: "https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824",
      permanent: false,
    },
    {
      source: "/mobile",
      has: [{ type: "header", key: "user-agent", value: ".*Android.*" }],
      destination: "https://play.google.com/store/apps/details?id=com.t3tools.t3code",
      permanent: false,
    },
    {
      source: "/mobile",
      destination: "/download",
      permanent: false,
    },
  ],
};
