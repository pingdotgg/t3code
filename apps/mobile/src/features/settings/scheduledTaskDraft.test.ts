import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerConfig,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
} from "@t3tools/contracts";
import { formatScheduledTaskInterval } from "./scheduledTaskPresentation";
import {
  scheduledTaskDefaultModel,
  DEFAULT_SCHEDULE,
  scheduleDraftForTask,
  scheduleFromDraft,
} from "./scheduledTaskDraft";

describe("scheduleDraftForTask", () => {
  it("opens legacy sub-minute schedules at the writable minimum", () => {
    const draft = scheduleDraftForTask({ schedule: { type: "interval", everyMs: 30_000 } });
    expect(draft.intervalMinutes).toBe("1");
    expect(draft.intervalWindowEnabled).toBe(false);
    expect(scheduleFromDraft(draft)).toEqual({ type: "interval", everyMs: 60_000 });
    expect(scheduleFromDraft(draft)).not.toHaveProperty("window");
  });

  it("restores a stored interval window and leaves a missing window off", () => {
    const open = scheduleDraftForTask({ schedule: { type: "interval", everyMs: 3_600_000 } });
    expect(open.intervalWindowEnabled).toBe(false);
    expect(open.weekdays).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(scheduleFromDraft(open)).toEqual({ type: "interval", everyMs: 3_600_000 });
    expect(scheduleFromDraft({ ...open, intervalWindowEnabled: true })).toEqual({
      type: "interval",
      everyMs: 3_600_000,
      window: { start: "10:00", end: "20:00" },
    });

    const limited = scheduleDraftForTask({
      schedule: {
        type: "interval",
        everyMs: 3_600_000,
        window: { start: "10:00", end: "20:00", weekdays: [5, 1, 4, 2, 3] },
      },
    });
    expect(limited.intervalWindowEnabled).toBe(true);
    expect(limited.intervalWindowStart).toBe("10:00");
    expect(limited.intervalWindowEnd).toBe("20:00");
    expect(limited.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(scheduleFromDraft(limited)).toEqual({
      type: "interval",
      everyMs: 3_600_000,
      window: { start: "10:00", end: "20:00", weekdays: [1, 2, 3, 4, 5] },
    });

    const daily = scheduleDraftForTask({
      schedule: { type: "interval", everyMs: 3_600_000, window: { start: "09:00", end: "17:30" } },
    });
    expect(daily.weekdays).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(scheduleFromDraft(daily)).toEqual({
      type: "interval",
      everyMs: 3_600_000,
      window: { start: "09:00", end: "17:30" },
    });
  });

  it("round-trips dedupe settings and rejects invalid windows", () => {
    const dedupe = {
      replayKey: "{{headers.delivery-id}}",
      coalesceKey: "{{body.id}}",
      coalesceWindowSeconds: 3600,
    };
    const draft = scheduleDraftForTask({ schedule: { type: "webhook", signature: null, dedupe } });
    expect(scheduleFromDraft(draft)).toMatchObject({ dedupe });
    expect(
      scheduleFromDraft({
        ...draft,
        replayKey: " \n ",
        coalesceKey: " \t ",
        coalesceWindowSeconds: "",
      }),
    ).toMatchObject({ dedupe: {} });
    expect(
      scheduleFromDraft({
        ...draft,
        replayKey: `  ${dedupe.replayKey}  `,
        coalesceKey: `\t${dedupe.coalesceKey}\n`,
      }),
    ).toMatchObject({ dedupe });
    expect(
      scheduleFromDraft({ ...draft, replayKey: "", coalesceKey: "", coalesceWindowSeconds: "" }),
    ).toMatchObject({ dedupe: {} });
    for (const coalesceWindowSeconds of ["9", "3601", "1.5", "abc"]) {
      expect(scheduleFromDraft({ ...draft, coalesceWindowSeconds })).toBeNull();
    }
  });

  it("keeps a webhook signature on save without sending a secret", () => {
    const signature = {
      header: "x-hub-signature-256",
      encoding: "hex" as const,
      prefix: "sha256=",
    };
    const saved = scheduleFromDraft(
      scheduleDraftForTask({ schedule: { type: "webhook", signature } }),
    );
    expect(saved).toEqual({ type: "webhook", signature, maxDeliveryAgeMinutes: null, dedupe: {} });
    expect(saved?.type === "webhook" && saved.signature && "secret" in saved.signature).toBe(false);
  });

  it("round-trips webhook filters and refuses an invalid one", () => {
    const filters = [
      { path: "headers.x-github-event", op: "equals", value: "pull_request" },
      { path: "body.label.name", op: "in", value: ["needs review", "agent:fix"] },
    ] as const;
    const draft = scheduleDraftForTask({ schedule: { type: "webhook", signature: null, filters } });
    // Untouched rows are left out, so the server keeps whatever is stored now.
    expect(scheduleFromDraft(draft)).not.toHaveProperty("filters");
    expect(scheduleFromDraft({ ...draft, filters: [] })).toMatchObject({ filters: [] });
    expect(scheduleFromDraft({ ...draft, filters: draft.filters.slice(1) })).toMatchObject({
      filters: filters.slice(1),
    });
    expect(
      scheduleFromDraft({ ...draft, filters: [{ id: "f1", path: "", op: "exists", value: "" }] }),
    ).toBeNull();
  });
});

describe("scheduleFromDraft", () => {
  it("rejects an empty day selection rather than silently scheduling every day", () => {
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, weekdays: [] })).toBeNull();
  });

  it.each([
    ["1.5", 90_000],
    ["2,5", 150_000],
    [" 2,5 ", 150_000],
    [String(60_001 / 60_000), 60_001],
  ])("preserves a valid %s minute interval when saving", (intervalMinutes, everyMs) => {
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "interval", intervalMinutes })).toEqual({
      type: "interval",
      everyMs,
    });
  });

  it.each(["0,5", "2,5,0", "Infinity", "150119987580", ""])(
    "rejects invalid interval minutes: %s",
    (intervalMinutes) => {
      expect(
        scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "interval", intervalMinutes }),
      ).toBeNull();
    },
  );

  it("encodes an interval window and omits it while the window is off", () => {
    const off = {
      ...DEFAULT_SCHEDULE,
      mode: "interval" as const,
      intervalMinutes: "60",
      intervalWindowStart: "20:00",
      intervalWindowEnd: "10:00",
    };
    expect(scheduleFromDraft(off)).toEqual({ type: "interval", everyMs: 3_600_000 });
    expect(scheduleFromDraft(off)).not.toHaveProperty("window");
    expect(
      scheduleFromDraft({
        ...off,
        intervalWindowEnabled: true,
        intervalWindowStart: "10:00",
        intervalWindowEnd: "20:00",
      }),
    ).toEqual({
      type: "interval",
      everyMs: 3_600_000,
      window: { start: "10:00", end: "20:00", weekdays: [1, 2, 3, 4, 5] },
    });
  });

  it("omits weekdays when an interval window covers every day", () => {
    const base = {
      ...DEFAULT_SCHEDULE,
      mode: "interval" as const,
      intervalMinutes: "60",
      intervalWindowEnabled: true,
      intervalWindowStart: "10:00",
      intervalWindowEnd: "20:00",
    };
    expect(scheduleFromDraft({ ...base, weekdays: [] })).toBeNull();
    for (const weekdays of [
      [0, 1, 2, 3, 4, 5, 6],
      [6, 5, 4, 3, 2, 1, 0, 0],
    ]) {
      expect(scheduleFromDraft({ ...base, weekdays })).toEqual({
        type: "interval",
        everyMs: 3_600_000,
        window: { start: "10:00", end: "20:00" },
      });
    }
  });

  it("rejects an interval window that does not end after it starts", () => {
    const base = {
      ...DEFAULT_SCHEDULE,
      mode: "interval" as const,
      intervalMinutes: "60",
      intervalWindowEnabled: true,
    };
    for (const [intervalWindowStart, intervalWindowEnd] of [
      ["10:00", "10:00"],
      ["20:00", "10:00"],
      ["22:00", "06:00"],
    ] as const) {
      expect(scheduleFromDraft({ ...base, intervalWindowStart, intervalWindowEnd })).toBeNull();
    }
  });
});

describe("interval window summary", () => {
  const window = { start: "10:00", end: "20:00" };

  it("keeps the plain interval text until a window is set", () => {
    expect(formatScheduledTaskInterval(3_600_000)).toBe("Every hour");
    expect(formatScheduledTaskInterval(3_600_000, { ...window, weekdays: [1, 2, 3, 4, 5] })).toBe(
      "Every 60 min, Mon–Fri 10:00–20:00",
    );
    expect(formatScheduledTaskInterval(3_600_000, window)).toBe(
      "Every 60 min, every day 10:00–20:00",
    );
    expect(formatScheduledTaskInterval(3_600_000, { ...window, weekdays: [] })).toBe(
      "Every 60 min, every day 10:00–20:00",
    );
    expect(
      formatScheduledTaskInterval(3_600_000, { ...window, weekdays: [0, 1, 2, 3, 4, 5, 6] }),
    ).toBe("Every 60 min, every day 10:00–20:00");
    expect(formatScheduledTaskInterval(3_600_000, { ...window, weekdays: [6, 0, 3] })).toBe(
      "Every 60 min, Wed, Sat, Sun 10:00–20:00",
    );
  });
});

describe("scheduled task model defaults", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const projectId = ProjectId.make("project");
  const environmentSelection = {
    instanceId,
    model: "environment-model",
    options: [{ id: "reasoning", value: "high" }],
  };
  const projectSelection = { instanceId, model: "project-model" };
  const config = {
    settings: { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: environmentSelection },
    providers: [
      {
        instanceId,
        driver: "codex",
        displayName: "Codex",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [
          { slug: "first-model", name: "First", isCustom: false, capabilities: null },
          {
            slug: "catalog-default",
            name: "Default",
            isDefault: true,
            isCustom: false,
            capabilities: null,
          },
          { slug: "environment-model", name: "Environment", isCustom: false, capabilities: null },
          { slug: "project-model", name: "Project", isCustom: false, capabilities: null },
        ],
      },
    ],
  } as unknown as ServerConfig;
  const resolve = scheduledTaskDefaultModel;
  it("prefers the project's configured model", () => {
    expect(resolve(config, { id: projectId, defaultModelSelection: projectSelection })).toEqual(
      projectSelection,
    );
    expect(
      resolve(
        {
          ...config,
          settings: {
            ...config.settings,
            projectSettingsOverrides: {
              [projectId]: { defaultModelSelection: projectSelection },
            },
          },
        },
        { id: projectId },
      ),
    ).toEqual(projectSelection);
  });
  it("uses the advertised default instead of catalog order when no default is configured", () => {
    expect(
      resolve({ ...config, settings: { ...config.settings, defaultModelSelection: null } }, null),
    ).toEqual({ instanceId, model: "catalog-default" });
  });
  it("falls back to the environment default when the project provider is unavailable", () => {
    expect(
      resolve(config, {
        id: projectId,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("unavailable"),
          model: "missing",
        },
      }),
    ).toEqual(environmentSelection);
  });
  it("does not choose an implicit model on a disabled provider", () => {
    expect(
      resolve(
        {
          ...config,
          settings: {
            ...config.settings,
            providerInstances: {
              [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
            },
          },
          providers: config.providers.map((provider) => ({ ...provider, enabled: false })),
        },
        null,
      ),
    ).toBeNull();
  });
});

it("rejects dedupe keys without valid request placeholders", () => {
  expect(
    scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "webhook", replayKey: "literal" }),
  ).toBeNull();
  expect(
    scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "webhook", coalesceKey: "{{body.bad" }),
  ).toBeNull();
});
