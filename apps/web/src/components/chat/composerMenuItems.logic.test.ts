import { expect, it } from "vite-plus/test";

import { folderMoveSlashCommandItems } from "./composerMenuItems.logic";

it("folderMoveSlashCommandItems blocks a row with the reason that choosing it reports", () => {
  const rows = (input: Parameters<typeof folderMoveSlashCommandItems>[0]) =>
    folderMoveSlashCommandItems(input).map(({ label, description, blockReason }) => ({
      label,
      description,
      blockReason,
    }));
  const free = { available: true, disabledReason: null, inNoProject: false };
  const cd = { label: "/cd", description: "Move this thread to another folder" };
  const no = { label: "/no", description: "Move to No project in a new scratch folder" };

  // An environment whose server cannot move threads offers neither command.
  expect(rows({ ...free, available: false })).toEqual([]);
  expect(rows(free)).toEqual([cd, no]);
  // `/no` has nowhere to go from No project, and `/cd` stays usable.
  expect(rows({ ...free, inNoProject: true })).toEqual([
    cd,
    {
      label: "/no",
      description: "This thread is already in No project",
      blockReason: "This thread is already in No project.",
    },
  ]);
  // What blocks every move wins over the `/no` reason. The row drops the final period only.
  const reason = "This thread is still working. Try again when the turn ends.";
  const blocked = { description: reason.slice(0, -1), blockReason: reason };
  expect(rows({ ...free, inNoProject: true, disabledReason: reason })).toEqual([
    { label: "/cd", ...blocked },
    { label: "/no", ...blocked },
  ]);
});
