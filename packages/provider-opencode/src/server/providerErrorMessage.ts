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

export function isExplicitProviderOverload(error: {
  readonly code?: string | undefined;
  readonly message?: string | undefined;
  readonly responseBody?: string | undefined;
}): boolean {
  const isOverloadCode = (value: unknown) =>
    typeof value === "string" &&
    /^(?:service[._-]overloaded|server[._-]overloaded|provider[._-]overloaded|overloaded[._-]error|overload[._-]error)$/.test(
      value.toLowerCase(),
    );
  if (isOverloadCode(error.code)) return true;
  if (
    /\b(?:service|server|provider|upstream)\s+(?:(?:is|was)\s+)?(?:temporarily\s+)?overloaded\b/i.test(
      error.message ?? "",
    )
  )
    return true;
  if (!error.responseBody) return false;
  try {
    const body: unknown = JSON.parse(error.responseBody);
    if (isOverloadCode(body)) return true;
    if (typeof body !== "object" || body === null) return false;
    const record = body as Record<string, unknown>;
    if (isOverloadCode(record.code) || isOverloadCode(record.type)) return true;
    if (typeof record.error !== "object" || record.error === null) return false;
    const nested = record.error as Record<string, unknown>;
    return isOverloadCode(nested.code) || isOverloadCode(nested.type);
  } catch {
    return false;
  }
}
