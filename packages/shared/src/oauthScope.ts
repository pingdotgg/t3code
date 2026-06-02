const OAUTH_SCOPE_TOKEN = /^[\u0021\u0023-\u005b\u005d-\u007e]+$/u;

/**
 * Decodes an RFC 6749 `scope` value as a set while preserving first-seen order.
 */
export function parseOAuthScope(value: string): ReadonlyArray<string> | null {
  if (value.length === 0) {
    return null;
  }

  const scopes = value.split(" ");
  if (scopes.some((scope) => !OAUTH_SCOPE_TOKEN.test(scope))) {
    return null;
  }

  return [...new Set(scopes)];
}

export function encodeOAuthScope(scopes: ReadonlyArray<string>): string {
  const encoded = scopes.join(" ");
  const parsed = parseOAuthScope(encoded);
  if (parsed === null || parsed.length !== scopes.length) {
    throw new Error("OAuth scopes must be non-empty, valid, and unique.");
  }
  return encoded;
}

export function parseAllowedOAuthScope<Scope extends string>(input: {
  readonly value: string;
  readonly allowedScopes: ReadonlySet<Scope>;
}): ReadonlyArray<Scope> | null {
  const scopes = parseOAuthScope(input.value);
  if (
    scopes === null ||
    !scopes.every((scope): scope is Scope => input.allowedScopes.has(scope as Scope))
  ) {
    return null;
  }
  return scopes;
}
