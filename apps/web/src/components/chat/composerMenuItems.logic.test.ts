import { expect, it } from "vite-plus/test";

import { folderMoveSlashCommandItems } from "./composerMenuItems.logic";

it("folderMoveSlashCommandItems blocks a row with the reason that choosing it reports", () => {
  const rows = (input: Parameters<typeof folderMoveSlashCommandItems>[0]) =>
    folderMoveSlashCommandItems(input).map(({ label, blockReason }) => ({ label, blockReason }));
  const free = { available: true, disabledReason: null, inNoProject: false };
  const cd = { label: "/cd" };
  const no = { label: "/no" };

  // An environment whose server cannot move threads offers neither command.
  expect(rows({ ...free, available: false })).toEqual([]);
  expect(rows(free)).toEqual([cd, no]);
  // `/no` has nowhere to go from No project, and `/cd` stays usable.
  expect(rows({ ...free, inNoProject: true })).toEqual([
    cd,
    { ...no, blockReason: expect.any(String) },
  ]);
  // What blocks every move wins over the `/no` reason.
  const reason = "This thread is still working. Try again when the turn ends.";
  expect(rows({ ...free, inNoProject: true, disabledReason: reason })).toEqual([
    { ...cd, blockReason: reason },
    { ...no, blockReason: reason },
  ]);
});
