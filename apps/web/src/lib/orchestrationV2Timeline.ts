export function removeAndRenumberTimelineItem<
  Id,
  Row extends { readonly position: number; readonly sourceItemId: Id },
>(rows: ReadonlyArray<Row>, sourceItemId: Id): Array<Row> {
  return rows
    .filter((row) => row.sourceItemId !== sourceItemId)
    .map((row, position) => ({ ...row, position }));
}

export function upsertTimelineItemAtStablePosition<
  Id,
  Row extends { readonly position: number; readonly sourceItemId: Id },
>(rows: ReadonlyArray<Row>, item: Row): Array<Row> {
  const existingIndex = rows.findIndex((row) => row.sourceItemId === item.sourceItemId);
  if (existingIndex === -1) {
    return [...rows, { ...item, position: rows.length }];
  }

  return rows.map((row, index) =>
    index === existingIndex ? { ...item, position: row.position } : row,
  );
}
