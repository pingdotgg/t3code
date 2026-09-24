import { satteri } from "@astrojs/markdown-satteri";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

import { docsHref } from "./src/lib/docsLinks.ts";
import { GITHUB_REPOSITORY_URL } from "./src/lib/site.ts";

export default defineConfig({
  site: "https://t3.codes",
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
  markdown: {
    processor: satteri({
      mdastPlugins: [
        {
          name: "t3-docs-links",
          link(node, ctx) {
            const href = docsHref(node.url);
            if (href !== node.url) ctx.setProperty(node, "url", href);
          },
        },
      ],
    }),
  },
  integrations: [
    starlight({
      title: "T3 Code",
      description: "Guides for installing, using, and running T3 Code.",
      logo: { src: "./src/assets/icon.webp" },
      favicon: "/favicon.ico",
      social: [
        { icon: "github", label: "GitHub", href: GITHUB_REPOSITORY_URL },
        { icon: "discord", label: "Discord", href: "https://discord.gg/jn4EGJjrvv" },
      ],
      customCss: ["./src/styles/fonts.css", "./src/styles/docs.css"],
      // The rest of the site owns its 404 behavior.
      disable404Route: true,
      markdown: { processedDirs: ["../../docs/user"] },
      // Every page in docs/user needs a slot here to appear in the navigation.
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Overview", slug: "docs" },
            "docs/install",
            "docs/welcome-wizard",
            "docs/updating",
          ],
        },
        {
          label: "Using T3 Code",
          items: [
            "docs/composer",
            "docs/thread-sidebar",
            "docs/permission-modes",
            "docs/question-attachments",
            "docs/terminal",
            "docs/source-control",
            "docs/snap-shot",
            "docs/browser-import",
            "docs/devices",
            "docs/usage",
          ],
        },
        {
          label: "Providers",
          items: [
            "docs/providers-codex",
            "docs/providers-claude",
            "docs/providers-opencode",
            "docs/providers-antigravity",
          ],
        },
        {
          label: "Remote and mobile",
          items: ["docs/remote-access", "docs/background-service", "docs/mobile-notifications"],
        },
        {
          label: "Settings",
          items: [
            "docs/project-settings",
            "docs/appearance",
            "docs/keybindings",
            "docs/keyboard-focus",
          ],
        },
        {
          label: "About",
          items: ["docs/telemetry", "docs/open-source-licenses"],
        },
      ],
    }),
  ],
});
