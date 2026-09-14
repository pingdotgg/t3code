import { describe, expect, it } from "vite-plus/test";

import {
  parseSlashCommandArgumentOptions,
  searchSlashCommandArgumentOptions,
} from "./slashCommandArguments";

describe("parseSlashCommandArgumentOptions", () => {
  it("reads the choices a required or optional hint enumerates", () => {
    expect(parseSlashCommandArgumentOptions("<plan|scan|status|cancel>")).toEqual([
      "plan",
      "scan",
      "status",
      "cancel",
    ]);
    expect(parseSlashCommandArgumentOptions("[on|off|status]")).toEqual(["on", "off", "status"]);
    expect(parseSlashCommandArgumentOptions("[soft|remote|snapcompact] [focus]")).toEqual([
      "soft",
      "remote",
      "snapcompact",
    ]);
  });

  it("keeps a choice that has an argument of its own", () => {
    expect(parseSlashCommandArgumentOptions("[on|off|status|dump [raw]|configure]")).toEqual([
      "on",
      "off",
      "status",
      "dump",
      "configure",
    ]);
  });

  it("offers nothing for a placeholder or a single value", () => {
    expect(parseSlashCommandArgumentOptions("[title]")).toEqual([]);
    expect(parseSlashCommandArgumentOptions("<subcommand>")).toEqual([]);
    expect(parseSlashCommandArgumentOptions("[--themes] [path]")).toEqual([]);
    expect(parseSlashCommandArgumentOptions(undefined)).toEqual([]);
  });
});

describe("searchSlashCommandArgumentOptions", () => {
  it("filters by prefix and keeps the hint's order", () => {
    const options = ["soft", "remote", "snapcompact"];

    expect(searchSlashCommandArgumentOptions(options, "s")).toEqual(["soft", "snapcompact"]);
    expect(searchSlashCommandArgumentOptions(options, "REM")).toEqual(["remote"]);
    expect(searchSlashCommandArgumentOptions(options, "")).toEqual(options);
    expect(searchSlashCommandArgumentOptions(options, "zz")).toEqual([]);
  });
});
