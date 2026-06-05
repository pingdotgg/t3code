import * as Schema from "effect/Schema";

export const DpopPublicJwk = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String.check(Schema.isNonEmpty()),
  y: Schema.String.check(Schema.isNonEmpty()),
});
export type DpopPublicJwk = typeof DpopPublicJwk.Type;

export function normalizeDpopHtu(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return null;
  }
}
