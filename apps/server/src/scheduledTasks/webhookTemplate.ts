/**
 * Renders a webhook task's prompt from the request that triggered it. The
 * rendered prompt is the only thing the agent receives, so a user who wants
 * the whole request writes `{{request}}` or `{{body}}` themselves.
 *
 * The syntax is deliberately just `{{path}}` lookups — no conditionals,
 * defaults, filters or escaping — so it never grows into a template language:
 *
 * - `{{body.a.b.0}}`   a field of a JSON or form-encoded body
 * - `{{headers.name}}` a request header (case-insensitive)
 * - `{{query.name}}`   a URL query parameter
 * - `{{body}}`         the raw body text
 * - `{{request}}`      method, path, query, headers and body
 *
 * Strings and numbers render as text, objects and arrays as JSON. A path with
 * no value renders empty and is reported in `missing`.
 */

export interface WebhookRequest {
  readonly method: string;
  readonly path: string;
  /** Raw query string without the leading `?`. */
  readonly query: string;
  /** Lowercased header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyText: string;
}

export interface RenderedWebhookPrompt {
  readonly prompt: string;
  readonly missing: ReadonlyArray<string>;
}

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

function parseBody(request: WebhookRequest): unknown {
  const contentType = (request.headers["content-type"] ?? "").toLowerCase();
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(request.bodyText));
  }
  // Senders are inconsistent about content types, so any body that parses
  // as JSON is addressable.
  try {
    return JSON.parse(request.bodyText) as unknown;
  } catch {
    return undefined;
  }
}

function lookup(root: unknown, segments: ReadonlyArray<string>): unknown {
  let current = root;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

function formatWebhookRequest(request: WebhookRequest): string {
  const headerLines = Object.entries(request.headers).map(([name, value]) => `${name}: ${value}`);
  return [
    `${request.method} ${request.path}${request.query ? `?${request.query}` : ""}`,
    ...headerLines,
    "",
    request.bodyText,
  ].join("\n");
}

export function renderWebhookPrompt(
  template: string,
  request: WebhookRequest,
): RenderedWebhookPrompt {
  const missing: string[] = [];
  let body: { parsed: unknown } | undefined;
  const parsedBody = () => (body ??= { parsed: parseBody(request) }).parsed;

  const resolve = (expression: string): unknown => {
    const [root, ...segments] = expression.split(".");
    switch (root) {
      case "request":
        return segments.length === 0 ? formatWebhookRequest(request) : undefined;
      case "body":
        return segments.length === 0 ? request.bodyText : lookup(parsedBody(), segments);
      case "headers":
        return segments.length === 0
          ? request.headers
          : request.headers[segments.join(".").toLowerCase()];
      case "query": {
        const params = new URLSearchParams(request.query);
        if (segments.length === 0) return Object.fromEntries(params);
        return params.get(segments.join(".")) ?? undefined;
      }
      default:
        return undefined;
    }
  };

  const prompt = template.replace(PLACEHOLDER, (_match, expression: string) => {
    const value = resolve(expression);
    if (value === undefined || value === null) {
      if (!missing.includes(expression)) missing.push(expression);
      return "";
    }
    return stringify(value);
  });
  return { prompt, missing };
}
