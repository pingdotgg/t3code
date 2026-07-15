import { PluginId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { performSettingsSave, settingsSaveErrorMessage, type Draft } from "./PluginSettingsPage";

const pluginId = PluginId.make("settings-page-plugin");

const draft = (overrides: Partial<Draft> = {}): Draft => ({
  values: { baseUrl: "https://stored.example" },
  revision: 4,
  incompatible: false,
  ...overrides,
});

describe("settingsSaveErrorMessage", () => {
  // The whole point of the squash: the server distinguishes a schema rejection
  // from a concurrent-edit conflict, and the user's next action differs. Reading
  // `.message` off the Cause instead of the failure inside it always missed, so
  // every failure produced the generic text.
  it("surfaces the server's own message rather than a generic fallback", () => {
    const message = settingsSaveErrorMessage({
      cause: Cause.fail({
        _tag: "PluginSettingsConflictError",
        message: "Plugin settings changed since revision 4 (now 5).",
      }),
    });
    expect(message).toBe("Plugin settings changed since revision 4 (now 5).");
  });

  it("falls back to a generic message when the failure carries none", () => {
    expect(settingsSaveErrorMessage({ cause: Cause.fail("boom") })).toBe(
      "Could not save settings.",
    );
  });
});

describe("performSettingsSave", () => {
  it("adopts the server's new revision BEFORE re-reading", async () => {
    const order: Array<string> = [];
    const applied: Array<Draft> = [];

    const outcome = await performSettingsSave({
      pluginId,
      draft: draft(),
      edited: { baseUrl: "https://edited.example" },
      save: (value) => {
        order.push(`save:${value.expectedRevision}`);
        return Promise.resolve(AsyncResult.success({ revision: 5 }));
      },
      applyDraft: (next) => {
        order.push("applyDraft");
        applied.push(next);
      },
      reload: () => {
        order.push("reload");
        return Promise.resolve(null);
      },
    });

    expect(outcome.error).toBeNull();
    // The ordering is the assertion. The write succeeded, so the server has
    // advanced; if the re-read fails and the pre-save revision were kept, the next
    // save would conflict against the user's OWN write.
    expect(order).toEqual(["save:4", "applyDraft", "reload"]);
    expect(applied[0]?.revision).toBe(5);
    expect(applied[0]?.incompatible).toBe(false);
  });

  it("re-reads after a successful save rather than trusting the client's edits", async () => {
    let reloads = 0;
    await performSettingsSave({
      pluginId,
      draft: draft(),
      edited: { baseUrl: "https://edited.example" },
      save: () => Promise.resolve(AsyncResult.success({ revision: 5 })),
      applyDraft: () => {},
      reload: () => {
        reloads += 1;
        return Promise.resolve(null);
      },
    });
    // The server canonicalises (decode -> re-encode, and strips undeclared keys at
    // every level), so stored values can legitimately differ from what was typed.
    expect(reloads).toBe(1);
  });

  it("sends the draft's revision so a stale save is rejected rather than clobbering", async () => {
    let sent: number | null = null;
    await performSettingsSave({
      pluginId,
      draft: draft({ revision: 9 }),
      edited: {},
      save: (value) => {
        sent = value.expectedRevision;
        return Promise.resolve(AsyncResult.success({ revision: 10 }));
      },
      applyDraft: () => {},
      reload: () => Promise.resolve(null),
    });
    expect(sent).toBe(9);
  });

  it("reports a failed re-read instead of showing a clean form", async () => {
    // The save succeeded and the revision advanced, but the re-read failed — so the
    // form is showing client-side edits that may not match storage. Returning
    // `{ error: null }` here let the caller's setError() wipe the error the reload
    // had just set: the user saw success while the form quietly disagreed with the
    // server. Reporting success while lying about consistency is the worst option.
    const outcome = await performSettingsSave({
      pluginId,
      draft: draft(),
      edited: { baseUrl: "https://edited.example" },
      save: () => Promise.resolve(AsyncResult.success({ revision: 5 })),
      applyDraft: () => {},
      reload: () => Promise.resolve("Could not load settings."),
    });

    expect(outcome.error).toBe("Could not load settings.");
  });

  it("keeps the draft and does not re-read when the save fails", async () => {
    let reloads = 0;
    let applies = 0;

    const outcome = await performSettingsSave({
      pluginId,
      draft: draft(),
      edited: { baseUrl: "https://edited.example" },
      save: () =>
        Promise.resolve(
          AsyncResult.failure(
            Cause.fail({
              _tag: "PluginSettingsConflictError",
              message: "Plugin settings changed since revision 4 (now 5).",
            }),
          ),
        ),
      applyDraft: () => {
        applies += 1;
      },
      reload: () => {
        reloads += 1;
        return Promise.resolve(null);
      },
    });

    expect(outcome.error).toBe("Plugin settings changed since revision 4 (now 5).");
    // A failed save must not advance the revision: doing so would send an
    // expectedRevision the server never issued.
    expect(applies).toBe(0);
    expect(reloads).toBe(0);
  });
});
