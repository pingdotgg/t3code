import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_FILE_LINK_INSTRUCTIONS,
  FILE_LINK_INSTRUCTIONS_MAX_LENGTH,
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

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const opencode = providerClients.get(ProviderDriverKind.make("opencode"));
    expect(opencode).toBeDefined();

    const serverUrl = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverUrl",
    );
    expect(serverUrl).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, serverUrl: "http://127.0.0.1:4096" },
      serverUrl!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("keeps file link instructions unset until edited, within Codex's limit, and resettable", () => {
    const claude = providerClients.get(ProviderDriverKind.make("claudeAgent"));
    const field = deriveProviderSettingsFields(claude!).find(
      ({ key }) => key === "fileLinkInstructions",
    );
    expect(field).toMatchObject({
      control: "textarea",
      defaultStringValue: DEFAULT_FILE_LINK_INSTRUCTIONS,
      maxLength: FILE_LINK_INSTRUCTIONS_MAX_LENGTH,
    });

    expect(nextProviderConfigWithFieldValue(undefined, field!, "Cite files as URLs.")).toEqual({
      fileLinkInstructions: "Cite files as URLs.",
    });
    expect(nextProviderConfigWithFieldValue({ launchArgs: "--chrome" }, field!, "")).toEqual({
      launchArgs: "--chrome",
      fileLinkInstructions: "",
    });
    expect(
      nextProviderConfigWithFieldValue(
        { launchArgs: "--chrome", fileLinkInstructions: "" },
        field!,
        DEFAULT_FILE_LINK_INSTRUCTIONS,
      ),
    ).toEqual({ launchArgs: "--chrome" });
  });

  it("offers file link instructions for local ACP agents", () => {
    const acpRegistry = providerClients.get(ProviderDriverKind.make("acpRegistry"));
    expect(
      deriveProviderSettingsFields(acpRegistry!, { source: "local" }).map(({ key }) => key),
    ).toEqual(["source", "commandPath", "fileLinkInstructions"]);
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
