import type { ServerProviderSkill } from "@t3tools/contracts";
import { preloadPatchFile } from "@pierre/diffs/ssr";
import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "../composerContextPresentation";
import { terminalThemeFromApp } from "../ThreadTerminalDrawer";
import { useRenderedAppearance, useTheme } from "../../hooks/useTheme";
import { DEFAULT_COMPOSER_PLACEHOLDER } from "../../composerPlaceholder";
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
        placeholder={DEFAULT_COMPOSER_PLACEHOLDER}
        className="max-h-42"
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

// FileDiff remounts can retain unhighlighted frames after a race; use static highlighted HTML in shadow DOM.
function loadDiffPreviewHtml(theme: DiffThemeName): Promise<readonly string[]> {
  return preloadPatchFile({
    patch: DIFF_PREVIEW_PATCH,
    options: { diffStyle: "unified", theme, preferredHighlighter: PREFERRED_HIGHLIGHTER },
  }).then((results) => results.map((result) => result.prerenderedHTML));
}

// Unlayered shadow-root rules override Pierre surfaces with app code tokens to match the diff panel.
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

// Each host is keyed by its html, so the ref callback runs once per document.
// React detaches a cleanup-less ref callback with null when an appearance switch drops the host.
function StaticDiffHtml({ html }: { html: string }) {
  const attachHtml = (host: HTMLDivElement | null) => {
    if (host === null) return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    shadow.innerHTML = html;
    const bridge = document.createElement("style");
    bridge.textContent = DIFF_PREVIEW_THEME_BRIDGE;
    shadow.append(bridge);
  };
  return <div ref={attachHtml} />;
}

const diffPreviewHtmlAtom = Atom.family((theme: DiffThemeName) =>
  Atom.make(Effect.promise(() => loadDiffPreviewHtml(theme))).pipe(
    Atom.keepAlive,
    Atom.withLabel(`settings-diff-preview:${theme}`),
  ),
);

export function CodeFontPreview() {
  const resolvedTheme = useRenderedAppearance();
  const loadedHtml = AsyncResult.getOrElse(
    useAtomValue(diffPreviewHtmlAtom(resolveDiffThemeName(resolvedTheme))),
    () => null,
  );
  // An appearance switch keeps the previous theme's preview up while the new one renders.
  const [htmlByFile, setHtmlByFile] = useState(loadedHtml);
  if (loadedHtml !== null && loadedHtml !== htmlByFile) setHtmlByFile(loadedHtml);
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
  "  \x1b[42;30m READY \x1b[0m \x1b[2mwatching for changes, press\x1b[0m \x1b[1mq\x1b[0m \x1b[2mto quit\x1b[0m\r\n" +
  "\r\n" +
  TERMINAL_PROMPT;
const TERMINAL_PREVIEW_ROWS = TERMINAL_PREVIEW_TRANSCRIPT.split("\r\n").length;

function previewTerminalFont(family: string, size: number): { family?: string; size: number } {
  const trimmed = family.trim();
  return trimmed.length > 0 ? { family: trimmed, size } : { size };
}

export function TerminalFontPreview({ family, size }: { family: string; size: number }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [surface, setSurface] = useState<GhosttyTerminalSurface | null>(null);
  const [initialFont] = useState(() => previewTerminalFont(family, size));
  const { theme, resolvedTheme } = useTheme();

  // The box grows with the font so the whole transcript shows without scrolling.
  useEffect(() => {
    if (!surface) return;
    void surface.setFont(previewTerminalFont(family, size)).then(() => {
      const mount = mountRef.current;
      if (!mount) return;
      // The border sits inside the box's height and is not part of the terminal's grid.
      const border = mount.offsetHeight - mount.clientHeight;
      mount.style.height = `${surface.heightForRows(TERMINAL_PREVIEW_ROWS) + border}px`;
      surface.fit();
    });
  }, [surface, family, size]);

  // Palette changes may preserve light/dark mode; re-read terminal tokens for every theme change.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !surface) return;
    surface.setTheme(terminalThemeFromApp(mount));
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The tokens come from the DOM's computed styles, which a theme change rewrites.
  }, [surface, theme, resolvedTheme]);

  const mountSurface = (mount: HTMLDivElement) => {
    mountRef.current = mount;
    let cancelled = false;
    let created: GhosttyTerminalSurface | null = null;
    let lineLength = 0;

    const echo = (data: string) => {
      if (!created) return;
      if (data === "\r") {
        created.write(`\r\n${TERMINAL_PROMPT}`);
        lineLength = 0;
        return;
      }
      if (data === "\x7f" || data === "\b") {
        if (lineLength > 0) {
          created.write("\b \b");
          lineLength -= 1;
        }
        return;
      }
      if (data.startsWith("\x1b")) return;
      const printable = [...data]
        .filter((character) => character >= " " && character !== "\x7f")
        .join("");
      if (printable.length === 0) return;
      created.write(printable);
      lineLength += printable.length;
    };

    void GhosttyTerminalSurface.create(mount, {
      theme: terminalThemeFromApp(mount),
      font: initialFont,
      onData: echo,
      onResize: noop,
      onSelectionChange: noop,
      beforeKey: (event) => event.key !== "Tab",
      onLinkActivate: noop,
    }).then((next) => {
      if (cancelled) {
        next.dispose();
        return;
      }
      created = next;
      next.write(TERMINAL_PREVIEW_TRANSCRIPT);
      setSurface(next);
    });

    return () => {
      cancelled = true;
      created?.dispose();
      mountRef.current = null;
      setSurface(null);
    };
  };

  return (
    <div
      ref={mountSurface}
      className="relative mt-1 mb-2 h-52 overflow-hidden rounded-lg border border-border"
      aria-label="Terminal font preview"
    />
  );
}
