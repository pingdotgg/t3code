import { describe, expect, it } from "vite-plus/test";

import {
  databaseMigrationProgress,
  DATABASE_MIGRATION_PROGRESS_MESSAGE as STEP,
  DATABASE_MIGRATIONS_STARTED_MESSAGE as START,
  DATABASE_MIGRATIONS_FINISHED_MESSAGE as FINISH,
} from "./databaseMigrationLog.ts";

describe("databaseMigrationProgress", () => {
  it.each([
    ["", null],
    [START, null],
    [`${STEP} (2 of 7)\n  progress: 2 of 7\n`, { current: 2, total: 7 }],
    [`${STEP} (2 of 7`, null],
    [`${STEP} (8 of 7)\n`, null],
    [`${STEP} progress="1 of 7"\n${STEP} progress="2 of 7"`, { current: 2, total: 7 }],
    [`${STEP} migration=<script>alert(1)</script> progress="2 of 7"`, { current: 2, total: 7 }],
    [`{"message":"${STEP}","progress":"3 of 7"}`, { current: 3, total: 7 }],
    [`${STEP} progress="2 of 7`, null],
    [`${STEP} progress="0 of 7"`, null],
    [`${STEP} progress="8 of 7"`, null],
    [`${STEP} progress="1 of 99999999999999999999"`, null],
    [`${STEP} progress="2 of 7"\n${FINISH}`, null],
    [`${STEP} progress="2 of 7"\n${START}`, null],
    [`${FINISH}\n${START}\n${STEP} progress="1 of 5"`, { current: 1, total: 5 }],
  ])("reads the current complete progress from %s", (output, expected) => {
    expect(databaseMigrationProgress(output)).toEqual(expected);
  });
});
