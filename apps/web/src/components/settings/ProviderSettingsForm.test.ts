import { describe, expect, it } from "vite-plus/test";
import {
  makeProviderSettingsSchema,
  ProviderDriverKind,
  SettingsSecretValue,
  TrimmedString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { providerClients } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  reconcileRowsDraft,
  seedRowsDraft,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("keeps every masked field as a stored secret and offers a reference only where typed so", () => {
    const settingsSchema = makeProviderSettingsSchema({
      token: TrimmedString.pipe(
        Schema.annotateKey({ providerSettingsForm: { control: "password" } }),
      ),
      apiKey: SettingsSecretValue,
    });

    expect(
      deriveProviderSettingsFields({ settingsSchema }).map(
        ({ key, secret, acceptsSecretReference }) => ({ key, secret, acceptsSecretReference }),
      ),
    ).toEqual([
      { key: "token", secret: true, acceptsSecretReference: undefined },
      { key: "apiKey", secret: true, acceptsSecretReference: true },
    ]);
  });

  it("preserves unknown config keys while editing or clearing configurable fields", () => {
    for (const { driver, key, value } of [
      { driver: "opencode", key: "serverUrl", value: "http://127.0.0.1:4096" },
      { driver: "antigravity", key: "autoCompactWindow", value: "840000" },
    ]) {
      const client = providerClients.get(ProviderDriverKind.make(driver));
      expect(client).toBeDefined();
      const field = deriveProviderSettingsFields(client!).find((field) => field.key === key);
      expect(field).toBeDefined();
      expect(nextProviderConfigWithFieldValue({ forkOwned: 1 }, field!, value)).toEqual({
        forkOwned: 1,
        [key]: value,
      });
      expect(nextProviderConfigWithFieldValue({ forkOwned: 1, [key]: value }, field!, "")).toEqual({
        forkOwned: 1,
      });
    }
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });
});

describe("reconcileRowsDraft", () => {
  let nextId = 0;
  const toRows = (values: ReadonlyArray<string>) =>
    values.map((value) => ({ id: nextId++, value }));
  const equal = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
    left.length === right.length && left.every((value, index) => value === right[index]);

  it("keeps rows when an equal value arrives with a new identity", () => {
    const draft = seedRowsDraft(["a"], toRows);
    expect(reconcileRowsDraft(draft, ["a"], equal, toRows)).toBe(draft);
  });

  it("keeps row ids when the published value echoes back", () => {
    const seeded = seedRowsDraft(["a"], toRows);
    const edited = { rows: [...seeded.rows, { id: 99, value: "" }], seen: seeded.seen };
    const draft = { ...edited, lastPublished: ["a", ""] };
    const next = reconcileRowsDraft(draft, ["a", ""], equal, toRows);
    expect(next.rows).toBe(draft.rows);
    expect(next.seen).toEqual(["a", ""]);
    expect(next.lastPublished).toBeUndefined();
  });

  it("reseeds rows when the value changes from outside", () => {
    const draft = { ...seedRowsDraft(["a"], toRows), lastPublished: ["b"] };
    const next = reconcileRowsDraft(draft, ["c"], equal, toRows);
    expect(next.rows.map((row) => row.value)).toEqual(["c"]);
    expect(next.lastPublished).toBeUndefined();
  });
});
