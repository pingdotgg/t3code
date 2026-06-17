export function removeAndRenumberTimelineItem<
  Id,
  Row extends { readonly position: number; readonly sourceItemId: Id },
>(rows: ReadonlyArray<Row>, sourceItemId: Id): Array<Row> {
  return rows
    .filter((row) => row.sourceItemId !== sourceItemId)
    .map((row, position) => ({ ...row, position }));
}
