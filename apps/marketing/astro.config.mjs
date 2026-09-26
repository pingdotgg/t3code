import { satteri } from "@astrojs/markdown-satteri";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

import { docsHref } from "./src/lib/docsLinks.ts";

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
      favicon: "/favicon.ico",
      components: {
        Header: "./src/components/docs/Header.astro",
        SiteTitle: "./src/components/docs/SiteTitle.astro",
        SocialIcons: "./src/components/docs/SocialIcons.astro",
        ThemeProvider: "./src/components/docs/ThemeProvider.astro",
        ThemeSelect: "./src/components/docs/ThemeSelect.astro",
      },
      customCss: ["./src/styles/fonts.css", "./src/styles/docs.css"],
      // Code blocks borrow the terminal window from the homepage.
      expressiveCode: {
        themes: ["github-dark-default"],
        styleOverrides: {
          borderRadius: "12px",
          borderColor: "rgba(255, 255, 255, 0.08)",
          codeBackground: "#0c0c0e",
          codeFontFamily: "var(--sl-font-mono)",
          codeFontSize: "13px",
          codeLineHeight: "1.7",
          codePaddingBlock: "16px",
          codePaddingInline: "20px",
          uiFontFamily: "var(--sl-font)",
          frames: {
            shadowColor: "transparent",
            frameBoxShadowCssValue: "none",
            terminalBackground: "#0c0c0e",
            terminalTitlebarBackground: "rgba(255, 255, 255, 0.02)",
            terminalTitlebarBorderBottomColor: "rgba(255, 255, 255, 0.08)",
            terminalTitlebarDotsForeground: "#2a2a30",
            terminalTitlebarDotsOpacity: "1",
            terminalTitlebarForeground: "#71717a",
            editorTabBarBackground: "rgba(255, 255, 255, 0.02)",
            editorActiveTabBackground: "#0c0c0e",
            editorActiveTabIndicatorTopColor: "transparent",
            editorTabBarBorderBottomColor: "rgba(255, 255, 255, 0.08)",
          },
        },
      },
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
