/**
 * Central typography definitions for SurgeCode content surfaces. Port of
 * `apps/mac/Sources/SergeCodeMac/Theme/SurgeTypography.swift`.
 *
 * System-facing chrome (menus, dialogs, native controls) stays on the system
 * font. These tokens are for branded application content only:
 *
 * - **Geist Sans** for conversations, task titles, project names, empty
 *   states, and the composer.
 * - **Geist Mono** for technical information: branches, model names, tool
 *   payloads, paths, code, and command arguments.
 *
 * macOS registers the bundled faces at launch through `CTFontManager` because
 * the app is a hand-assembled SwiftPM bundle. The web build has no such
 * problem — the faces are imported by `fonts.css` and Vite fingerprints them
 * into `dist/assets` — but the *fallback* rule is the same and matters just as
 * much: every token names an equivalent system face so a missing font never
 * changes the layout's metrics beyond the substitution itself.
 *
 * The macOS system fallback is `.system(...)` (SF Pro / SF Mono). The Windows
 * equivalents are Segoe UI Variable (the Windows 11 UI face) and Cascadia
 * Mono, with the generic families last.
 */

export const SANS_STACK =
  '"Geist", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif';
export const MONO_STACK = '"Geist Mono", "Cascadia Mono", "Consolas", ui-monospace, monospace';

export interface FontToken {
  readonly family: string;
  /** Points on macOS map 1:1 to CSS px in the webview at 100% scaling. */
  readonly size: number;
  readonly weight: number;
}

function sans(size: number, weight: number): FontToken {
  return { family: SANS_STACK, size, weight };
}

function mono(size: number, weight: number): FontToken {
  return { family: MONO_STACK, size, weight };
}

// Geist ships Regular/Medium/SemiBold; the numeric weights below are the
// PostScript faces the macOS tokens name.
const REGULAR = 400;
const MEDIUM = 500;
const SEMIBOLD = 600;

// MARK: - Titles and navigation content

export const threadTitle = sans(16, SEMIBOLD);
export const sidebarTaskTitle = sans(13, MEDIUM);
export const inspectorEmptyStateTitle = sans(15, SEMIBOLD);

// MARK: - Conversation typography

export const chatBody = sans(14.5, REGULAR);
export const chatEmphasis = sans(14.5, SEMIBOLD);
export const agentStatus = sans(13, REGULAR);
export const composer = sans(14, REGULAR);

// MARK: - Tool and technical typography

export const toolTitle = sans(13, MEDIUM);
export const technicalMetadata = mono(11.5, MEDIUM);
export const toolPayload = mono(12, REGULAR);

/** Geist Mono at an arbitrary size — for zoomable code surfaces (diff review). */
export function code(size = 13): FontToken {
  return mono(size, REGULAR);
}

/** `font:` shorthand-ish declaration for a token. */
export function fontCss(token: FontToken): string {
  return `${token.weight} ${token.size}px ${token.family}`;
}

/**
 * Every token as CSS custom properties, applied once to the document root.
 * Components reference `var(--font-chat-body)` rather than re-deriving sizes,
 * so a change here lands everywhere at once — the same single-source-of-truth
 * the macOS enum provides.
 */
export function typographyCssVariables(): Record<string, string> {
  return {
    "--font-sans": SANS_STACK,
    "--font-mono": MONO_STACK,
    "--font-thread-title": fontCss(threadTitle),
    "--font-sidebar-task-title": fontCss(sidebarTaskTitle),
    "--font-inspector-empty-state-title": fontCss(inspectorEmptyStateTitle),
    "--font-chat-body": fontCss(chatBody),
    "--font-chat-emphasis": fontCss(chatEmphasis),
    "--font-agent-status": fontCss(agentStatus),
    "--font-composer": fontCss(composer),
    "--font-tool-title": fontCss(toolTitle),
    "--font-technical-metadata": fontCss(technicalMetadata),
    "--font-tool-payload": fontCss(toolPayload),
    "--font-code": fontCss(code()),
  };
}
