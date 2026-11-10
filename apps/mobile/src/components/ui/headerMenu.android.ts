export function splitAndroidHeaderActions<Action extends { readonly overflowOnly?: boolean }>(
  actions: ReadonlyArray<Action>,
  wide: boolean,
) {
  const inline = actions.filter((action) => !action.overflowOnly);
  const directCount = actions.length > 2 ? (wide ? 3 : 1) : inline.length;
  const visibleActions = inline.slice(0, directCount);
  return {
    visibleActions,
    overflowActions: actions.filter((action) => !visibleActions.includes(action)),
  };
}
