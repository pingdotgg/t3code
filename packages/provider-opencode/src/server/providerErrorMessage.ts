/** OpenCode stores `<none>` when it cannot read the provider body. */
export function readableProviderErrorMessage(
  message?: string,
  status?: number,
  body?: string,
): string | undefined {
  const text = message?.trim() ?? "";
  if (text && text.toLowerCase() !== "<none>") return text;
  const title = body
    ?.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]
    ?.replace(/\s+/g, " ")
    .trim();
  if (title) return typeof status === "number" ? `${title} (HTTP ${status}).` : title;
  if (typeof status === "number") return `The model provider failed the request (HTTP ${status}).`;
  return text
    ? "The model provider failed the request and did not include an error message."
    : undefined;
}
