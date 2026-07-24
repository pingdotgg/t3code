import { describe, expect, it } from "vite-plus/test";

import { upsertT3ProjectFileScript } from "./t3ProjectFileScripts";

const script = {
  id: "script-test",
  name: "Test",
  command: "vp test",
  icon: "test" as const,
  runOnWorktreeCreate: false,
  autoOpenPreview: false,
};

describe("upsertT3ProjectFileScript", () => {
  it("creates a project file for the first shared action", () => {
    const result = JSON.parse(
      upsertT3ProjectFileScript({
        contents: null,
        script,
      }),
    );

    expect(result).toEqual({
      $schema: "https://t3.codes/schema/t3.json",
      scripts: [
        {
          name: "Test",
          command: "vp test",
          icon: "test",
          runOnWorktreeCreate: false,
        },
      ],
    });
  });

  it("appends an action while preserving existing project settings", () => {
    const result = JSON.parse(
      upsertT3ProjectFileScript({
        contents: JSON.stringify({
          $schema: "https://t3.codes/schema/t3.json",
          iconPath: "assets/logo.svg",
          futureSetting: { enabled: true },
          scripts: [{ name: "Dev", command: "vp dev" }],
        }),
        script,
      }),
    );

    expect(result.iconPath).toBe("assets/logo.svg");
    expect(result.futureSetting).toEqual({ enabled: true });
    expect(result.scripts).toEqual([
      { name: "Dev", command: "vp dev" },
      {
        name: "Test",
        command: "vp test",
        icon: "test",
        runOnWorktreeCreate: false,
      },
    ]);
  });

  it("updates an edited shared action instead of duplicating it", () => {
    const previousScript = { ...script, name: "Checks", command: "vp check" };
    const result = JSON.parse(
      upsertT3ProjectFileScript({
        contents: JSON.stringify({
          scripts: [{ name: "Checks", command: "vp check" }],
        }),
        previousScript,
        script,
      }),
    );

    expect(result.scripts).toHaveLength(1);
    expect(result.scripts[0]).toMatchObject({ name: "Test", command: "vp test" });
  });

  it("rejects an invalid existing project file", () => {
    expect(() =>
      upsertT3ProjectFileScript({
        contents: "{ invalid",
        script,
      }),
    ).toThrow("t3.json is invalid");
  });

  it("does not exceed the shared action limit", () => {
    expect(() =>
      upsertT3ProjectFileScript({
        contents: JSON.stringify({
          scripts: Array.from({ length: 50 }, (_, index) => ({
            name: `Action ${index}`,
            command: `echo ${index}`,
          })),
        }),
        script,
      }),
    ).toThrow("maximum of 50 shared actions");
  });
});
