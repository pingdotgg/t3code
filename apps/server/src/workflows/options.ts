/**
 * Refuses an option the call does not take. A workflow file is not type-checked, so a misspelt or
 * renamed option would otherwise be dropped without a word.
 */
export const checkOptions = (
  what: string,
  options: object | undefined,
  allowed: ReadonlyArray<string>,
) => {
  if (options === undefined || options === null) return;
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  const listed = (keys: ReadonlyArray<string>) => keys.map((key) => `\`${key}\``).join(", ");
  throw new Error(`${what} does not take ${listed(unknown)}. It takes ${listed(allowed)}.`);
};
