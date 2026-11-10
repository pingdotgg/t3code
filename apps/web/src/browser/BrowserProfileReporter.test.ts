import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type ProfileReport,
  type ReportedProfiles,
  takeDueProfileReports,
} from "./BrowserProfileReporter";

const first = EnvironmentId.make("environment-1");
const second = EnvironmentId.make("environment-2");
const config = (label: string) => ({ label }) as unknown as EnvironmentServerConfig;
const input = (recordingFrameRate: number) =>
  ({ profiles: [], defaultProfileId: "default", recordingFrameRate }) as unknown as ProfileReport;

describe("takeDueProfileReports", () => {
  it("reports each environment once per config and input", () => {
    const reported: ReportedProfiles = new Map();
    const configA = config("a");
    const configB = config("b");
    const settings = input(10);
    const targets = new Map([
      [first, configA],
      [second, configB],
    ]);

    expect(takeDueProfileReports(reported, targets, settings)).toEqual([first, second]);
    expect(takeDueProfileReports(reported, new Map(targets), settings)).toEqual([]);

    const restarted = config("a-restarted");
    expect(
      takeDueProfileReports(
        reported,
        new Map([
          [first, restarted],
          [second, configB],
        ]),
        settings,
      ),
    ).toEqual([first]);
  });

  it("reports every target again when the profile settings change", () => {
    const reported: ReportedProfiles = new Map();
    const targets = new Map([
      [first, config("a")],
      [second, config("b")],
    ]);
    takeDueProfileReports(reported, targets, input(10));

    expect(takeDueProfileReports(reported, targets, input(30))).toEqual([first, second]);
  });

  it("reports an environment again once it becomes operable again", () => {
    const reported: ReportedProfiles = new Map();
    const configA = config("a");
    const settings = input(10);
    takeDueProfileReports(reported, new Map([[first, configA]]), settings);

    expect(takeDueProfileReports(reported, new Map(), settings)).toEqual([]);
    expect(takeDueProfileReports(reported, new Map([[first, configA]]), settings)).toEqual([first]);
  });
});
