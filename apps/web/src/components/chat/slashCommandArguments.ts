/**
 * Argument completion for provider slash commands.
 *
 * Agents describe a command's argument in one free-form hint string —
 * omp sends `<plan|scan|status|…>` for `/security` and `[on|off|status]` for
 * `/fast`. Where that hint is an enumeration, the composer can offer the
 * choices instead of making the user remember them; where it is a
 * placeholder (`[title]`, `<path>`), there is nothing to offer and the user
 * types freely.
 */

/** First `<…>` or `[…]` group of a hint: the argument being completed now. */
const FIRST_HINT_GROUP_PATTERN = /[<[]([^<>[\]]*(?:\[[^\]]*\][^<>[\]]*)*)[>\]]/;
/** A literal a user could type: a word or a flag, not a placeholder phrase. */
const HINT_LITERAL_PATTERN = /^-{0,2}[A-Za-z][\w-]*$/;

/**
 * Read the choices a hint enumerates, in hint order. Returns an empty list
 * for placeholders and for single-choice hints: one "option" is not a menu,
 * it is the argument's name.
 */
export function parseSlashCommandArgumentOptions(hint: string | undefined): ReadonlyArray<string> {
  const group = hint === undefined ? null : FIRST_HINT_GROUP_PATTERN.exec(hint);
  const body = group?.[1];
  if (body === undefined || !body.includes("|")) {
    return [];
  }
  const options: Array<string> = [];
  for (const alternative of body.split("|")) {
    // `dump [raw]` enumerates `dump`; the nested group is that choice's own
    // argument and is completed on the next keystroke, not here.
    const literal = alternative.trim().split(/\s+/)[0] ?? "";
    if (HINT_LITERAL_PATTERN.test(literal) && !options.includes(literal)) {
      options.push(literal);
    }
  }
  return options.length > 1 ? options : [];
}

/** Prefix-filter the choices, keeping hint order. Empty query keeps all. */
export function searchSlashCommandArgumentOptions(
  options: ReadonlyArray<string>,
  query: string,
): ReadonlyArray<string> {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return options;
  }
  return options.filter((option) => option.toLowerCase().startsWith(normalized));
}
