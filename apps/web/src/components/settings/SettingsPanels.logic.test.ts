import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";
import {
  autoSettleDaysField,
  type AutoSettleDaysField,
  backgroundActivitySharedPolicySettings,
  cancelAutoSettleDaysField,
  commitAutoSettleDaysField,
  editAutoSettleDaysField,
  failAutoSettleDaysField,
  getChangedBrowserSettingLabels,
  hasChangedBackgroundActivitySettings,
  syncAutoSettleDaysField,
} from "./SettingsPanels.logic";

describe("background activity settings restore", () => {
  it("detects legacy interval values even when the structured setting is at its default", () => {
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: Duration.seconds(45),
        providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      }),
    ).toBe(true);
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
        providerHealthRefreshInterval: Duration.minutes(7),
      }),
    ).toBe(true);
    expect(hasChangedBackgroundActivitySettings(DEFAULT_UNIFIED_SETTINGS)).toBe(false);
  });

  it("preserves advanced overrides when the shared policy changes", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          backgroundActivity: {
            schemaVersion: 1,
            profile: "custom",
            baseProfile: "balanced",
            overrides: {
              automaticGitFetchInterval,
              pauseWhenOnBattery: true,
            },
          },
        },
        "performance",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval,
        pauseWhenOnBattery: true,
      },
    });
  });

  it("materializes legacy advanced overrides before changing the shared policy", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          automaticGitFetchInterval,
        },
        "battery-saver",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "battery-saver",
      overrides: {
        automaticGitFetchInterval,
      },
    });
  });
});

describe("getChangedBrowserSettingLabels", () => {
  it("counts a retained custom search URL so restore clears it", () => {
    expect(
      getChangedBrowserSettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        browserCustomSearchUrl: "https://search.example/?q=%s",
      }),
    ).toEqual(["Search engine"]);
  });
});

describe("auto-settle days field", () => {
  const type = (field: AutoSettleDaysField, ...drafts: string[]) =>
    drafts.reduce(editAutoSettleDaysField, field);

  it("saves only the finished edit, never a value typed on the way", () => {
    const typed = type(autoSettleDaysField(14), "1", "", "3", "30");
    expect(typed.pending).toBeNull();

    const committed = commitAutoSettleDaysField(typed);
    expect(committed.submit).toBe(30);
    expect(commitAutoSettleDaysField(committed.field).submit).toBeNull();

    const confirmed = syncAutoSettleDaysField(committed.field, 30);
    expect(confirmed).toMatchObject({ saved: 30, draft: "30", pending: null });
  });

  it.each(["", "0", "91", "1.5", "abc"])("restores the saved value for %j", (draft) => {
    const committed = commitAutoSettleDaysField(type(autoSettleDaysField(14), draft));
    expect(committed.submit).toBeNull();
    expect(committed.field.draft).toBe("14");
  });

  it("a rejected save falls back to the saved value and can be retried", () => {
    const submitted = commitAutoSettleDaysField(type(autoSettleDaysField(14), "30")).field;
    expect(failAutoSettleDaysField(submitted, submitted.revision).draft).toBe("14");

    const rejectedWhileCleared = failAutoSettleDaysField(type(submitted, ""), submitted.revision);
    expect(rejectedWhileCleared.draft).toBe("");
    expect(commitAutoSettleDaysField(rejectedWhileCleared).field.draft).toBe("14");
    expect(commitAutoSettleDaysField(type(rejectedWhileCleared, "30")).submit).toBe(30);
  });

  it("retyping a value that saved on only some environments sends it again", () => {
    const submitted = commitAutoSettleDaysField(type(autoSettleDaysField(14), "30")).field;
    const partlySaved = failAutoSettleDaysField(
      syncAutoSettleDaysField(submitted, 30),
      submitted.revision,
    );
    expect(commitAutoSettleDaysField(partlySaved).submit).toBeNull();
    expect(commitAutoSettleDaysField(type(partlySaved, "3", "30")).submit).toBe(30);
  });

  it("returning to the saved value while another save is in flight saves it again", () => {
    const submitted = commitAutoSettleDaysField(type(autoSettleDaysField(14), "30")).field;
    const back = commitAutoSettleDaysField(type(submitted, "14"));
    expect(back.submit).toBe(14);
    expect(failAutoSettleDaysField(back.field, submitted.revision)).toBe(back.field);

    const settled = syncAutoSettleDaysField(back.field, 14);
    expect(settled.pending).toBeNull();
    expect(syncAutoSettleDaysField(settled, 14)).toBe(settled);
    expect(syncAutoSettleDaysField(settled, 20).draft).toBe("20");
  });

  it("keeps a later save in flight when an earlier one is confirmed", () => {
    const first = commitAutoSettleDaysField(type(autoSettleDaysField(14), "30")).field;
    const second = commitAutoSettleDaysField(type(first, "60")).field;
    const firstConfirmed = syncAutoSettleDaysField(second, 30);
    expect(firstConfirmed).toMatchObject({ saved: 30, draft: "60", pending: 60 });
    expect(failAutoSettleDaysField(firstConfirmed, second.revision)).toMatchObject({
      draft: "30",
      pending: null,
    });
  });

  it("a cancelled edit restores the saved value and saves nothing", () => {
    const cancelled = cancelAutoSettleDaysField(type(autoSettleDaysField(14), "1"));
    expect(cancelled).toMatchObject({ draft: "14", dirty: false });
    expect(commitAutoSettleDaysField(cancelled).submit).toBeNull();
  });

  it("keeps a draft in progress when the saved value changes underneath it", () => {
    const typing = type(autoSettleDaysField(14), "4");
    expect(syncAutoSettleDaysField(typing, 30)).toMatchObject({ saved: 30, draft: "4" });
  });
});
