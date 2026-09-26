import { assertId, copyJson, validateContext, type ViewContext } from "./contracts.js";

export const MAX_CONTEXTS = 8;
export const MAX_CONTEXT_TEXT_BYTES = 8 * 1024;
export const MAX_CONTEXT_TOTAL_BYTES = 32 * 1024;
const bytes = (text: string) => new TextEncoder().encode(text).length;
export interface TextContributionDescriptor {
  readonly id: string;
  readonly title: string;
  readonly clients: readonly string[];
}
export interface ContextContent {
  readonly title: string;
  readonly text: string;
  readonly sourceUrl?: string;
}
export interface ContextSnapshot extends ContextContent {
  readonly version: 1;
  readonly id: string;
  readonly contributionId: string;
  readonly extensionVersion: string;
  readonly capturedAt: string;
  readonly origin: ViewContext["resource"];
}
export interface ComposerContextContribution {
  readonly id: string;
  /** Explicit user selection only; synchronous ready content, with no send or store access. */
  select(context: ViewContext): ContextContent;
}
export interface MessageContext {
  readonly environmentId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly text: string;
}
export interface MessageCard extends ContextContent {
  readonly contributionId: string;
}
export interface MessageDecorationContribution {
  readonly id: string;
  /** Pure read-only projection of one immutable visible message. */
  decorate(message: MessageContext): ContextContent | null;
}
export function validateContextContent(value: ContextContent): ContextContent {
  const result = copyJson(value, MAX_CONTEXT_TEXT_BYTES + 4096);
  if (
    typeof result.title !== "string" ||
    !result.title.trim() ||
    result.title.length > 200 ||
    typeof result.text !== "string" ||
    !result.text.trim() ||
    bytes(result.text) > MAX_CONTEXT_TEXT_BYTES ||
    result.text.includes("\uFFFC")
  )
    throw new Error("Context requires a title and at most 8 KiB of text");
  if (result.sourceUrl !== undefined) {
    const url = new URL(result.sourceUrl);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      result.sourceUrl.length > 2048
    )
      throw new Error("Context source must be an HTTP(S) URL without credentials");
  }
  return result;
}
export function validateContextSnapshot(value: ContextSnapshot): ContextSnapshot {
  const result = copyJson(value, MAX_CONTEXT_TEXT_BYTES + 4096);
  validateContextContent(result);
  assertId(result.contributionId);
  validateContext({ resource: result.origin, client: "snapshot" });
  if (
    result.version !== 1 ||
    typeof result.id !== "string" ||
    !result.id ||
    result.id.length > 200 ||
    typeof result.extensionVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(result.extensionVersion) ||
    typeof result.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(result.capturedAt))
  )
    throw new Error("Invalid captured context");
  return result;
}
const PREFIX = "[T3 context v1 ";
/** All payload text is readable in the original message, including on clients without extensions. */
export function formatContextSnapshot(value: ContextSnapshot): string {
  const snapshot = validateContextSnapshot(value);
  const metadata = JSON.stringify({
    id: snapshot.id,
    contributionId: snapshot.contributionId,
    extensionVersion: snapshot.extensionVersion,
    capturedAt: snapshot.capturedAt,
    origin: snapshot.origin,
    title: snapshot.title,
    ...(snapshot.sourceUrl ? { sourceUrl: snapshot.sourceUrl } : {}),
  });
  return (
    PREFIX + metadata + "]\n" + snapshot.text.length + "\n" + snapshot.text + "\n[/T3 context]"
  );
}
export interface ParsedContextSnapshot {
  readonly snapshot: ContextSnapshot;
  readonly start: number;
  readonly end: number;
}
export function readContextSnapshots(text: string): readonly ParsedContextSnapshot[] {
  const result: ParsedContextSnapshot[] = [];
  if (!text.includes(PREFIX) || bytes(text) > 256 * 1024) return result;
  let cursor = 0;
  while (result.length <= MAX_CONTEXTS) {
    const start = text.indexOf(PREFIX, cursor);
    if (start < 0) break;
    const headerEnd = text.indexOf("]\n", start);
    if (headerEnd < 0) break;
    cursor = headerEnd + 2;
    const lengthEnd = text.indexOf("\n", cursor);
    const lengthText = text.slice(cursor, lengthEnd);
    if (lengthEnd < 0 || !/^[0-9]{1,5}$/.test(lengthText)) continue;
    const bodyStart = lengthEnd + 1,
      bodyEnd = bodyStart + Number(lengthText);
    const suffix = "\n[/T3 context]";
    if (text.slice(bodyEnd, bodyEnd + suffix.length) !== suffix) continue;
    try {
      const metadata: unknown = JSON.parse(text.slice(start + PREFIX.length, headerEnd));
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) continue;
      const snapshot = validateContextSnapshot({
        ...metadata,
        version: 1,
        text: text.slice(bodyStart, bodyEnd),
      } as ContextSnapshot);
      const end = bodyEnd + suffix.length;
      result.push({ snapshot, start, end });
      cursor = end;
    } catch {
      /* An edited/unknown block remains ordinary readable prompt text. */
    }
  }
  return result;
}
export function assertContextBudget(text: string): void {
  const contexts = readContextSnapshots(text);
  if (
    (text.includes(PREFIX) && bytes(text) > 256 * 1024) ||
    contexts.length > MAX_CONTEXTS ||
    contexts.reduce((size, item) => size + bytes(text.slice(item.start, item.end)), 0) >
      MAX_CONTEXT_TOTAL_BYTES
  )
    throw new Error("Use at most 8 contexts and 32 KiB of captured context");
}
export function appendContextSnapshot(prompt: string, snapshot: ContextSnapshot): string {
  const next =
    prompt + (prompt && !prompt.endsWith("\n") ? "\n\n" : "") + formatContextSnapshot(snapshot);
  assertContextBudget(next);
  return next;
}
export function removeContextSnapshot(prompt: string, id: string): string {
  const entry = readContextSnapshots(prompt).find((item) => item.snapshot.id === id);
  return entry ? prompt.slice(0, entry.start) + prompt.slice(entry.end) : prompt;
}

/** Core display fallback: all captured content stays readable without exposing transport metadata. */
export function readableContextPrompt(prompt: string): string {
  const contexts = readContextSnapshots(prompt);
  if (contexts.length === 0) return prompt;
  let result = "",
    cursor = 0;
  for (const { snapshot, start, end } of contexts) {
    result += prompt.slice(cursor, start);
    result +=
      snapshot.title +
      "\n" +
      "Captured from " +
      snapshot.contributionId +
      " · " +
      snapshot.capturedAt +
      "\n" +
      (snapshot.sourceUrl ? snapshot.sourceUrl + "\n" : "") +
      snapshot.text;
    cursor = end;
  }
  return result + prompt.slice(cursor);
}

/** Context identities are not credentials; getRandomValues also works on remote HTTP origins. */
export function createContextSnapshotId(): string {
  const random = new Uint8Array(16);
  globalThis.crypto.getRandomValues(random);
  return "ctx-" + [...random].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
