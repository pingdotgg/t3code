// @effect-diagnostics globalFetch:off
/**
 * Pre-turn SuperCompress helper.
 *
 * Compresses bulky *context* in a user message before it is sent to a coding
 * agent provider. The user ask / query is never compressed.
 *
 * Uses injectable `fetch` (not Effect HttpClient) so turn-start can fail-open
 * through `Effect.tryPromise` without pulling HttpClient into the reactor.
 */

export const SUPERCOMPRESS_API_URL = "https://www.supercompress.dev/api/v1/compress";
export const SUPERCOMPRESS_DEFAULT_TIMEOUT_MS = 14_000;

export type CompressFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type CompressTurnMessageInput = {
  readonly text: string;
  readonly apiKey: string;
  readonly minChars?: number | undefined;
  readonly codingAgent?: string | undefined;
  readonly fetchImpl?: CompressFetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly apiUrl?: string | undefined;
};

export type CompressTurnMessageResult = {
  readonly text: string;
  readonly compressed: boolean;
  readonly skipped?: string | undefined;
  readonly originalTokens?: number | undefined;
  readonly compressedTokens?: number | undefined;
  readonly savingsPct?: number | undefined;
};

export function isSuperCompressApiKey(value: string): boolean {
  const key = value.trim();
  return key.startsWith("sc_") && !key.includes("${");
}

/**
 * Split a long user paste into ask (query) + context.
 * Short messages → all ask, empty context (no compress).
 * Long messages → first paragraph / ~400 chars as ask, rest as context.
 */
export function splitAskAndContext(
  text: string,
  minChars: number,
): { readonly ask: string; readonly context: string } {
  const raw = String(text ?? "");
  if (raw.trim().length < minChars) {
    return { ask: raw.trim(), context: "" };
  }
  const parts = raw.split(/\n\s*\n/);
  if (parts.length >= 2 && parts[0]!.trim().length <= 500) {
    return {
      ask: parts[0]!.trim(),
      context: parts.slice(1).join("\n\n").trim(),
    };
  }
  const head = raw.slice(0, 400);
  const nl = head.lastIndexOf("\n");
  const cut = nl > 80 ? nl : 400;
  return {
    ask: raw.slice(0, cut).trim() || "Compress the following context for the coding task.",
    context: raw.slice(cut).trim(),
  };
}

function assembleCompressedMessage(ask: string, compressedContext: string): string {
  const a = ask.trim();
  const c = compressedContext.trim();
  if (!c) return a;
  if (!a) return c;
  return `${a}\n\n${c}`;
}

/**
 * Compress bulky context in a turn message. Fail-open: any skip/error returns
 * the original text so the coding agent still runs.
 */
export async function compressTurnMessage(
  input: CompressTurnMessageInput,
): Promise<CompressTurnMessageResult> {
  const original = String(input.text ?? "");
  const apiKey = input.apiKey.trim();
  const minChars = input.minChars ?? 800;

  if (!isSuperCompressApiKey(apiKey)) {
    return { text: original, compressed: false, skipped: "no_key" };
  }

  const { ask, context } = splitAskAndContext(original, minChars);
  if (!context) {
    return { text: original, compressed: false, skipped: "no_context" };
  }
  if (context.length < 40) {
    return { text: original, compressed: false, skipped: "too_small" };
  }

  const fetchImpl: CompressFetch | undefined =
    input.fetchImpl ??
    (typeof globalThis.fetch === "function"
      ? (url, init) => globalThis.fetch(url, init)
      : undefined);
  if (!fetchImpl) {
    return { text: original, compressed: false, skipped: "no_fetch" };
  }

  const clipped = context.length > 160_000 ? context.slice(0, 160_000) : context;
  const timeoutMs = input.timeoutMs ?? SUPERCOMPRESS_DEFAULT_TIMEOUT_MS;
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;

  try {
    const response = await fetchImpl(input.apiUrl ?? SUPERCOMPRESS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        context: clipped,
        query: ask || "Compress this context for the coding task.",
        mode: "compiler",
        coding_agent: input.codingAgent || "T3 Code",
      }),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      return { text: original, compressed: false, skipped: `http_${response.status}` };
    }

    const body = (await response.json()) as Record<string, unknown>;
    const compressedContext =
      (typeof body.compressed_text === "string" && body.compressed_text) ||
      (typeof body.compressed_context === "string" && body.compressed_context) ||
      (typeof body.compressed === "string" && body.compressed) ||
      clipped;

    if (typeof compressedContext !== "string" || compressedContext.trim().length === 0) {
      return { text: original, compressed: false, skipped: "empty_result" };
    }

    // Never expand the payload.
    if (compressedContext.length >= clipped.length) {
      return { text: original, compressed: false, skipped: "no_savings" };
    }

    const inTok =
      typeof body.original_tokens === "number"
        ? body.original_tokens
        : Math.round(clipped.length / 4);
    const outTok =
      typeof body.kept_tokens === "number"
        ? body.kept_tokens
        : typeof body.compressed_tokens === "number"
          ? body.compressed_tokens
          : Math.round(compressedContext.length / 4);
    const savingsPct =
      typeof body.tokens_saved_pct === "number"
        ? Math.round(body.tokens_saved_pct)
        : typeof body.kv_savings_pct === "number"
          ? Math.round(body.kv_savings_pct)
          : inTok > 0
            ? Math.round(((inTok - outTok) / inTok) * 100)
            : 0;

    return {
      text: assembleCompressedMessage(ask, compressedContext),
      compressed: true,
      originalTokens: inTok,
      compressedTokens: outTok,
      savingsPct,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "error";
    return { text: original, compressed: false, skipped: message };
  }
}
