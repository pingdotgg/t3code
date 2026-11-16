import { decodeHTMLStrict } from "entities";

/** The character a named reference such as `amp` stands for, or null when HTML has none. */
export function decodeEntity(name: string): string | null {
  const reference = `&${name};`;
  const value = decodeHTMLStrict(reference);
  return value === reference ? null : value;
}
