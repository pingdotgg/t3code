// Ported from LocalRouter (github.com/jayleaton/localrouter @fe24726, apps/desktop-helper/src/computer/controller.ts),
// Apache-2.0, Copyright 2026 Jay Leaton. Modified for Ada: shared with the server, which checks typed text against it.

const FILE_EXTENSIONS = String.raw`(?:txt|md|pdf|png|jpe?g|gif|svg|webp|heic|docx?|xlsx?|pptx?|csv|json|ya?ml|toml|js|ts|tsx|jsx|mjs|py|rb|go|rs|sh|zip|dmg|pkg|mov|mp3|mp4|wav|log|key|pages|numbers|html?|css|swift|java)`;

/**
 * The address a navigation goal names, exactly as written: "go to example.com" → "example.com", "open
 * https://example.com/a in Chrome" → that URL. Null for anything else (the decider never writes text: this is the
 * request's own words).
 */
export function navigationText(goal: string): string | null {
  // Never an address inside an email address ("bob@example.com").
  // Any top-level domain, but not a file name ("notes.txt"), plus localhost and an IPv4 address, with a port.
  const host = String.raw`(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?!${FILE_EXTENSIONS}\b)[a-z]{2,24}\b)`;
  const address = String.raw`(?<![@\w.-])(?:https?:\/\/[^\s"“”'‘’<>]+|${host}(?::\d{2,5})?(?:\/[^\s"“”'‘’<>]*)?)`;
  // The address right after the verb: "go to example.com", "navigate Chrome to x.com", "take me to x.com"; not "open the
  // email from x.com" (the address is not what is opened).
  const toVerb = String.raw`\b(?:go|navigate|browse|head|get|take\s+me|bring\s+me|switch)(?:\s+\S+){0,3}?\s+to\s+`;
  const openVerb = String.raw`\b(?:open|visit|load|pull\s+up|bring\s+up|show\s+me|launch)\s+`;
  const what = String.raw`(?:the\s+)?(?:(?:web)?site\s+|page\s+|url\s+|address\s+)?`;
  const found = new RegExp(`(?:${toVerb}|${openVerb})${what}(${address})`, "i").exec(goal)?.[1];
  return found ? found.replace(/[.,;:!?)]+$/, "") : null;
}
