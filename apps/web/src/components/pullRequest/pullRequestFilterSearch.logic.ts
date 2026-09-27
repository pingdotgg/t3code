/**
 * A searched filter submenu's rows: the first ("all") option, the selection, then the first ten
 * matches by label. `empty` is set when a search leaves nothing but the "all" option.
 */
export function searchFilterOptions<
  Option extends { readonly value: string; readonly label: string },
>(
  options: ReadonlyArray<Option>,
  value: string,
  query: string,
): { readonly shown: ReadonlyArray<Option>; readonly empty: boolean } {
  const needle = query.trim().toLowerCase();
  const rest = options.slice(1);
  const selected = rest.find((option) => option.value === value);
  const matches = rest.filter(
    (option) => option !== selected && option.label.toLowerCase().includes(needle),
  );
  return {
    shown: [...options.slice(0, 1), ...(selected ? [selected] : []), ...matches.slice(0, 10)],
    empty: needle.length > 0 && matches.length === 0 && !selected,
  };
}

/** Labels matching a search by name; checked labels always stay. */
export function searchLabelOptions<Label extends { readonly name: string }>(
  labels: ReadonlyArray<Label>,
  checked: ReadonlyArray<string>,
  query: string,
): ReadonlyArray<Label> {
  const needle = query.trim().toLowerCase();
  const kept = new Set(checked.map((name) => name.toLowerCase()));
  return labels.filter(
    (label) => kept.has(label.name.toLowerCase()) || label.name.toLowerCase().includes(needle),
  );
}
