import * as Schema from "effect/Schema";

const OAUTH_SCOPE_TOKEN = /^[\u0021\u0023-\u005b\u005d-\u007e]+$/u;

export class OAuthScopeEncodingError extends Schema.TaggedErrorClass<OAuthScopeEncodingError>()(
  "OAuthScopeEncodingError",
  {
    scopes: Schema.Array(Schema.String),
    invalidScopes: Schema.Array(Schema.String),
    duplicateScopes: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return "OAuth scopes must be non-empty, syntactically valid, and unique.";
  }
}

/**
 * Decodes an RFC 6749 `scope` value as a set while preserving its first-seen
 * order for canonical responses and logs.
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
  const invalidScopes = scopes.filter((scope) => !OAUTH_SCOPE_TOKEN.test(scope));
  const seen = new Set<string>();
  const duplicateScopes = new Set<string>();
  for (const scope of scopes) {
    if (seen.has(scope)) duplicateScopes.add(scope);
    seen.add(scope);
  }

  if (scopes.length === 0 || invalidScopes.length > 0 || duplicateScopes.size > 0) {
    throw new OAuthScopeEncodingError({
      scopes,
      invalidScopes,
      duplicateScopes: [...duplicateScopes],
    });
  }
  return scopes.join(" ");
}

export function oauthScopeSetEquals(value: string, expectedScopes: ReadonlyArray<string>): boolean {
  const scopes = parseOAuthScope(value);
  return (
    scopes !== null &&
    scopes.length === new Set(expectedScopes).size &&
    scopes.every((scope) => expectedScopes.includes(scope))
  );
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
