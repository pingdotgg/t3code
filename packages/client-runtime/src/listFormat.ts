import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

/** "A, B, and C" in `locale`. Hermes ships without Intl.ListFormat, so it joins with `resolve`. */
export function formatConjunctionList(
  items: ReadonlyArray<string>,
  locale: string,
  resolve: MFunctionType = mFallback,
): string {
  if (typeof Intl.ListFormat === "function") {
    return new Intl.ListFormat(locale, { type: "conjunction" }).format(items);
  }
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) {
    return resolve(
      msg("{first} and {second}", { first: items[0]!, second: items[1]!, $context: "list of two" }),
    );
  }
  let list = resolve(
    msg("{first}, and {last}", {
      first: items.at(-2)!,
      last: items.at(-1)!,
      $context: "last two items of a list of three or more",
    }),
  );
  for (let index = items.length - 3; index >= 0; index -= 1) {
    list = resolve(
      msg("{first}, {rest}", {
        first: items[index]!,
        rest: list,
        $context: "an item followed by the rest of a list",
      }),
    );
  }
  return list;
}
