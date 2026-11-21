import { describe, expect, it } from "@effect/vitest";

import { readDatabaseMigrationProgress } from "./databaseMigrationLog.ts";

describe("readDatabaseMigrationProgress", () => {
  it.each([
    ["no migration output", "[16:04:46] INFO (#1): Listening\n", null],
    [
      "a new database before any progress line",
      "INFO Running database migrations\n",
      { step: null, total: null },
    ],
    [
      "the server's pretty console logger",
      "[16:04:46.293] INFO (#1): Upgrading database\n  migration: 95_X\n  progress: 2 of 14\n" +
        "[16:04:54.101] INFO (#1): Upgrading database\n  migration: 96_Y\n  progress: 3 of 14\n",
      { step: 3, total: 14 },
    ],
    [
      "logfmt",
      'INFO Upgrading database migration=95_X progress="7 of 80"\n',
      { step: 7, total: 80 },
    ],
    [
      "a progress line whose annotations have not arrived yet",
      "INFO (#1): Upgrading database\n  migration: 95_X\n  progress: 2 of 14\nINFO (#1): Upgrading database\n",
      { step: null, total: null },
    ],
    [
      "a finished upgrade",
      "INFO Upgrading database\n  progress: 14 of 14\nINFO Migrations ran successfully\n",
      null,
    ],
  ])("reads %s", (_name, output, expected) => {
    expect(readDatabaseMigrationProgress(output)).toEqual(expected);
  });
});
