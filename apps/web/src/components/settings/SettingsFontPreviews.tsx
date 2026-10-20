import type { ServerProviderSkill } from "@t3tools/contracts";
import { preloadPatchFile } from "@pierre/diffs/ssr";
import { useEffect, useRef, useState } from "react";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "../composerContextPresentation";
import { terminalThemeFromApp } from "../ThreadTerminalDrawer";
import { useRenderedAppearance, useTheme } from "../../hooks/useTheme";
import { DISCONNECTED_COMPOSER_PLACEHOLDER } from "../../composerPlaceholder";
import { resolveDiffThemeName, type DiffThemeName } from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import { GhosttyTerminalSurface } from "~/terminal/ghostty/surface";

const PREVIEW_SKILLS: ReadonlyArray<ServerProviderSkill> = [
  { name: "frontend-design", path: ".agents/skills/frontend-design/SKILL.md", enabled: true },
];

const PROMPT_PREVIEW_TEXT =
  "Use $frontend-design to fix the flaky test in " +
  "[surface.test.ts](apps/web/src/terminal/ghostty/surface.test.ts) and align the header with " +
  "[SettingsPanels.tsx](apps/web/src/components/settings/SettingsPanels.tsx) before shipping.";

function noop() {}

export function ReplyFontPreview() {
  return (
    <p className="mt-1 mb-2 rounded-lg border border-border bg-background px-3 py-2 font-reply text-sm leading-relaxed">
      Let’s build something thoughtful. I can help you get started with <code>helloWorld()</code>.
    </p>
  );
}

export function PromptFontPreview() {
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const [prompt, setPrompt] = useState(PROMPT_PREVIEW_TEXT);
  const [cursor, setCursor] = useState(PROMPT_PREVIEW_TEXT.length);
  const onChange = (nextValue: string, nextCursor: number) => {
    setPrompt(nextValue);
    setCursor(nextCursor);
  };
  return (
    <div className="mt-1 mb-2 rounded-lg border border-border bg-background px-3 py-2">
      <ComposerPromptEditor
        ariaLabel="Prompt font preview"
        editorRef={editorRef}
        value={prompt}
        cursor={cursor}
        contextRecords={EMPTY_COMPOSER_CONTEXT_RECORDS}
        skills={PREVIEW_SKILLS}
        disabled={false}
        placeholder={DISCONNECTED_COMPOSER_PLACEHOLDER}
        className="max-h-42 min-h-14"
        onChange={onChange}
        onPaste={noop}
      />
    </div>
  );
}

const DIFF_PREVIEW_PATCH = [
  "diff --git a/src/formatUser.ts b/src/formatUser.ts",
  "--- a/src/formatUser.ts",
  "+++ b/src/formatUser.ts",
  "@@ -1,3 +1,3 @@",
  " export function formatUser(user: User) {",
  "-  return user.name.toUpperCase();",
  "+  return `${user.name} <${user.email}>`; // 0O 1lI",
  " }",
  "",
].join("\n");

// The interactive FileDiff's mount lifecycle can race that highlighter when the typography views
// remount it (toggling Advanced) and lock in an unhighlighted frame; a static preview needs none
// of that lifecycle, so it uses the deterministic renderer and injects the finished HTML into a
// shadow root, exactly as FileDiff would.
const diffPreviewHtmlByTheme = new Map<DiffThemeName, Promise<readonly string[]>>();

function loadDiffPreviewHtml(theme: DiffThemeName): Promise<readonly string[]> {
  let promise = diffPreviewHtmlByTheme.get(theme);
  if (promise === undefined) {
    promise = preloadPatchFile({
      patch: DIFF_PREVIEW_PATCH,
      options: { diffStyle: "unified", theme, preferredHighlighter: PREFERRED_HIGHLIGHTER },
    }).then((results) => results.map((result) => result.prerenderedHTML));
    diffPreviewHtmlByTheme.set(theme, promise);
  }
  return promise;
}

// Pierre's prerendered stylesheet bakes its own light/dark surface colors
// into the shadow root's @layer rules. These unlayered rules win the cascade
// without !important and re-point the surfaces at the app's code tokens
// (custom properties inherit across the shadow boundary), so the preview
// follows the active theme exactly like the real diff panel does.
const DIFF_PREVIEW_THEME_BRIDGE = `
  :host {
    color: var(--code-foreground);
    background-color: var(--code-background);
    --diffs-fg: var(--code-foreground);
    --diffs-bg: var(--code-background);
    --diffs-light-bg: var(--code-background);
    --diffs-dark-bg: var(--code-background);
  }
  [data-diffs-header] {
    background-color: var(--code-background);
    color: var(--code-foreground);
  }
`;

function StaticDiffHtml({ html }: { html: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    shadow.innerHTML = html;
    const bridge = document.createElement("style");
    bridge.textContent = DIFF_PREVIEW_THEME_BRIDGE;
    shadow.append(bridge);
  }, [html]);
  return <div ref={hostRef} />;
}

export function CodeFontPreview() {
  const resolvedTheme = useRenderedAppearance();
  const themeName = resolveDiffThemeName(resolvedTheme);
  const [htmlByFile, setHtmlByFile] = useState<readonly string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadDiffPreviewHtml(themeName).then((html) => {
      if (!cancelled) setHtmlByFile(html);
    });
    return () => {
      cancelled = true;
    };
  }, [themeName]);
  if (htmlByFile === null) return null;
  return (
    <div className="mt-1 mb-2 space-y-2">
      {htmlByFile.map((html) => (
        <StaticDiffHtml key={html} html={html} />
      ))}
    </div>
  );
}

const TERMINAL_PROMPT =
  "\x1b[1;32m→\x1b[0m \x1b[1;36mt3code\x1b[0m \x1b[1;34mgit:(\x1b[1;31mmain\x1b[1;34m)\x1b[0m \x1b[1;33m✗\x1b[0m ";
const TERMINAL_PREVIEW_TRANSCRIPT =
  `${TERMINAL_PROMPT}vpr dev\r\n` +
  "\r\n" +
  "  \x1b[1;32mVITE\x1b[0m \x1b[32mv7.1.1\x1b[0m  \x1b[2mready in\x1b[0m \x1b[1m1.24s\x1b[0m\r\n" +
  "\r\n" +
  "  \x1b[32m→\x1b[0m  \x1b[2mLocal:\x1b[0m    \x1b[4;36mhttp://127.0.0.1:5173/\x1b[0m\r\n" +
  "  \x1b[32m→\x1b[0m  \x1b[2mNetwork:\x1b[0m  \x1b[4;36mhttp://192.168.1.24:5173/\x1b[0m\r\n" +
  "\r\n" +
  "  \x1b[32m✓ 85 passed\x1b[0m   \x1b[33m△ 2 warnings\x1b[0m   \x1b[31m✗ 0 failed\x1b[0m\r\n" +
  "\r\n" +
  "  \x1b[42;30m READY \x1b[0m \x1b[2mwatching for changes — press\x1b[0m \x1b[1mq\x1b[0m \x1b[2mto quit\x1b[0m\r\n" +
  "\r\n" +
  TERMINAL_PROMPT;

function previewTerminalFont(family: string, size: number): { family?: string; size: number } {
  const trimmed = family.trim();
  return trimmed.length > 0 ? { family: trimmed, size } : { size };
}

export function TerminalFontPreview({ family, size }: { family: string; size: number }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<GhosttyTerminalSurface | null>(null);
  const fontRef = useRef({ family, size });
  const { theme, resolvedTheme } = useTheme();

  useEffect(() => {
    const current = fontRef.current;
    if (current.family === family && current.size === size) return;
    fontRef.current = { family, size };
    void surfaceRef.current?.setFont(previewTerminalFont(family, size));
  }, [family, size]);

  // Re-read the terminal tokens on any theme change — switching between two
  // palettes can leave resolvedTheme (light/dark) untouched.
  useEffect(() => {
    const mount = mountRef.current;
    const surface = surfaceRef.current;
    if (!mount || !surface) return;
    surface.setTheme(terminalThemeFromApp(mount));
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The tokens come from the DOM's computed styles, which a theme change rewrites.
  }, [theme, resolvedTheme]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let cancelled = false;
    let lineLength = 0;

    const echo = (data: string) => {
      const surface = surfaceRef.current;
      if (!surface) return;
      if (data === "\r") {
        surface.write(`\r\n${TERMINAL_PROMPT}`);
        lineLength = 0;
        return;
      }
      if (data === "\x7f" || data === "\b") {
        if (lineLength > 0) {
          surface.write("\b \b");
          lineLength -= 1;
        }
        return;
      }
      if (data.startsWith("\x1b")) return;
      const printable = [...data]
        .filter((character) => character >= " " && character !== "\x7f")
        .join("");
      if (printable.length === 0) return;
      surface.write(printable);
      lineLength += printable.length;
    };

    void GhosttyTerminalSurface.create(mount, {
      theme: terminalThemeFromApp(mount),
      font: previewTerminalFont(fontRef.current.family, fontRef.current.size),
      onData: echo,
      onResize: noop,
      onSelectionChange: noop,
      beforeKey: (event) => event.key !== "Tab",
      onLinkActivate: noop,
    }).then((surface) => {
      if (cancelled) {
        surface.dispose();
        return;
      }
      surfaceRef.current = surface;
      surface.setTheme(terminalThemeFromApp(mount));
      const font = fontRef.current;
      void surface.setFont(previewTerminalFont(font.family, font.size));
      surface.write(TERMINAL_PREVIEW_TRANSCRIPT);
    });

    return () => {
      cancelled = true;
      surfaceRef.current?.dispose();
      surfaceRef.current = null;
    };
  }, []);

  return (
    <div
      ref={mountRef}
      className="relative mt-1 mb-2 h-52 overflow-hidden rounded-lg border border-border"
      aria-label="Terminal font preview"
    />
  );
}
