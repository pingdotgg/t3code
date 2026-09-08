/**
 * Local-vs-live mode indicators in the plan/deploy renderers.
 *
 * The rule (shared by the Ink TUI and the non-interactive LoggingCli via
 * `formatModeNote`): dev tags EVERY mode-stamped row; deploy tags only the
 * local exceptions —
 *   - dev (default local): local rows get a `local` tag, live rows get a
 *     `remote` tag (the `Alchemy.remote()` vocabulary; the persisted enum
 *     stays "live")
 *   - deploy (default live): local rows get a `local` tag; live rows are
 *     quiet
 *   - mode-agnostic rows (no resolved mode) are never tagged
 *   - mode-switch replacements always show the transition (`local → live`)
 */
import { formatModeNote, modeLabel } from "@/Cli/ModeTag.ts";
import { formatPlanLines } from "@/Cli/LoggingCli.ts";
import type { CRUD, Plan } from "@/Plan.ts";
import type { ProviderMode } from "@/ProviderMode.ts";
import { describe, expect, test } from "alchemy-test";

describe("formatModeNote", () => {
  test("mode-agnostic rows (no resolved mode) show nothing", () => {
    expect(
      formatModeNote({ mode: undefined, defaultMode: "live" }),
    ).toBeUndefined();
    expect(
      formatModeNote({ mode: undefined, defaultMode: "local" }),
    ).toBeUndefined();
  });

  test("a live row during deploy (default live) is quiet", () => {
    expect(
      formatModeNote({ mode: "live", defaultMode: "live" }),
    ).toBeUndefined();
  });

  test("a local row during dev (default local) is tagged local", () => {
    // Dev tags EVERY stamped row — knowing what's emulated is the point.
    expect(formatModeNote({ mode: "local", defaultMode: "local" })).toBe(
      "local",
    );
  });

  test("a local row during deploy (default live) is tagged local", () => {
    expect(formatModeNote({ mode: "local", defaultMode: "live" })).toBe(
      "local",
    );
  });

  test("a live row during dev (default local) is tagged remote", () => {
    expect(formatModeNote({ mode: "live", defaultMode: "local" })).toBe(
      "remote",
    );
  });

  test("a missing default mode is treated as live", () => {
    expect(
      formatModeNote({ mode: "live", defaultMode: undefined }),
    ).toBeUndefined();
    expect(formatModeNote({ mode: "local", defaultMode: undefined })).toBe(
      "local",
    );
  });

  test("a mode-switch replacement always shows the transition", () => {
    // Even though the target mode matches the run default, the transition
    // is surfaced.
    expect(
      formatModeNote({ mode: "live", priorMode: "local", defaultMode: "live" }),
    ).toBe("local → live");
    expect(
      formatModeNote({
        mode: "local",
        priorMode: "live",
        defaultMode: "local",
      }),
    ).toBe("live → local");
  });

  test("a same-mode replacement falls back to the exception rule", () => {
    expect(
      formatModeNote({ mode: "live", priorMode: "live", defaultMode: "live" }),
    ).toBeUndefined();
    expect(
      formatModeNote({
        mode: "local",
        priorMode: "local",
        defaultMode: "live",
      }),
    ).toBe("local");
  });

  test("modeLabel maps the persisted enum to display vocabulary", () => {
    expect(modeLabel("live")).toBe("remote");
    expect(modeLabel("local")).toBe("local");
  });
});

// ── formatPlanLines (the non-interactive plan preview) ─────────────────────

const crud = (options: {
  id: string;
  action: CRUD["action"];
  mode?: ProviderMode;
  priorMode?: ProviderMode;
}): CRUD =>
  ({
    action: options.action,
    mode: options.mode,
    state:
      options.priorMode !== undefined
        ? { providerMode: options.priorMode }
        : {},
    bindings: [],
    resource: {
      LogicalId: options.id,
      Type: "Test.Resource",
      FQN: options.id,
    },
  }) as unknown as CRUD;

const makePlan = (options: {
  defaultMode?: ProviderMode;
  resources?: Record<string, CRUD>;
  deletions?: Record<string, CRUD>;
}): Plan =>
  ({
    resources: options.resources ?? {},
    deletions: options.deletions ?? {},
    actions: {},
    actionDeletions: {},
    output: undefined,
    cycleMembers: new Set<string>(),
    defaultMode: options.defaultMode,
  }) as unknown as Plan;

const lineFor = (lines: string[], id: string) =>
  lines.find((line) => line.includes(`[${id}]`));

describe("formatPlanLines rename tags", () => {
  test("a migrated resource shows its former FQN", () => {
    const lines = formatPlanLines(
      makePlan({
        defaultMode: "live",
        resources: {
          Assets: {
            ...crud({ id: "Assets", action: "update", mode: "live" }),
            renamedFrom: ["Bucket"],
          } as CRUD,
        },
      }),
    );
    expect(lineFor(lines, "Assets")).toContain("(renamed from Bucket)");
  });
});

describe("formatPlanLines mode tags", () => {
  test("deploy (default live): local deletion rows get a dim local tag", () => {
    const lines = formatPlanLines(
      makePlan({
        defaultMode: "live",
        resources: {
          Api: crud({ id: "Api", action: "create", mode: "live" }),
        },
        deletions: {
          DevWorker: crud({
            id: "DevWorker",
            action: "delete",
            mode: "local",
            priorMode: "local",
          }),
        },
      }),
    );
    expect(lineFor(lines, "Api")).not.toContain("(local");
    expect(lineFor(lines, "Api")).not.toContain("(remote");
    expect(lineFor(lines, "DevWorker")).toContain("(local)");
  });

  test("dev (default local): remote() rows get a dim remote tag", () => {
    const lines = formatPlanLines(
      makePlan({
        defaultMode: "local",
        resources: {
          Emulated: crud({ id: "Emulated", action: "create", mode: "local" }),
          RealQueue: crud({ id: "RealQueue", action: "create", mode: "live" }),
          ModeAgnostic: crud({ id: "ModeAgnostic", action: "create" }),
        },
      }),
    );
    expect(lineFor(lines, "Emulated")).toContain("(local)");
    expect(lineFor(lines, "RealQueue")).toContain("(remote)");
    expect(lineFor(lines, "ModeAgnostic")).not.toContain("(remote");
    expect(lineFor(lines, "ModeAgnostic")).not.toContain("(local");
  });

  test("mode-switch replacements annotate the transition", () => {
    const lines = formatPlanLines(
      makePlan({
        defaultMode: "live",
        resources: {
          Worker: crud({
            id: "Worker",
            action: "replace",
            mode: "live",
            priorMode: "local",
          }),
        },
      }),
    );
    expect(lineFor(lines, "Worker")).toContain("(local → live)");
  });

  test("a plan without defaultMode treats live as the default", () => {
    const lines = formatPlanLines(
      makePlan({
        resources: {
          Api: crud({ id: "Api", action: "update", mode: "live" }),
          Dev: crud({ id: "Dev", action: "update", mode: "local" }),
        },
      }),
    );
    expect(lineFor(lines, "Api")).not.toContain("(remote");
    expect(lineFor(lines, "Dev")).toContain("(local)");
  });
});
