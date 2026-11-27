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

  it("only offers a Codex shadow home when the instance already uses one", () => {
    const codex = providerClients.get(ProviderDriverKind.make("codex"))!;
    const fields = (config: unknown) =>
      deriveProviderSettingsFields(codex, config).map((field) => field.key);
    expect(fields({})).not.toContain("shadowHomePath");
    expect(fields({ shadowHomePath: "/saved/profile" })).toContain("shadowHomePath");
  });

  it("shows Antigravity credential fields only for the sign-in methods that read them, or while set", () => {
    const antigravity = providerClients.get(ProviderDriverKind.make("antigravity"));
    expect(antigravity).toBeDefined();
    const keysFor = (value?: unknown) =>
      deriveProviderSettingsFields(antigravity!, value).map((field) => field.key);

    expect(keysFor({})).toEqual(["authMethod", "binaryPath"]);
    expect(
      keysFor({
        authMethod: "oauth-personal",
        apiKey: { provider: "vault", reference: "antigravity" },
        gcpLocation: "us-central1",
      }),
    ).toEqual(["authMethod", "apiKey", "gcpLocation", "binaryPath"]);
    expect(keysFor({ authMethod: "oauth-business" })).toEqual([
      "authMethod",
      "gcpProject",
      "gcpLocation",
      "binaryPath",
    ]);
    expect(keysFor({ authMethod: "gemini-api-key" })).toEqual([
      "authMethod",
      "apiKey",
      "binaryPath",
    ]);
    expect(keysFor({ authMethod: "agent-platform" })).toEqual([
      "authMethod",
      "apiKey",
      "gcpProject",
      "gcpLocation",
      "binaryPath",
    ]);
    expect(keysFor()).toEqual(["authMethod", "apiKey", "gcpProject", "gcpLocation", "binaryPath"]);
  });

  it("does not store a text value its field's schema rejects", () => {
    const claude = providerClients.get(ProviderDriverKind.make("claudeAgent"));
    expect(claude).toBeDefined();
    const autoCompactWindow = deriveProviderSettingsFields(claude!).find(
      (field) => field.key === "autoCompactWindow",
    );
    expect(autoCompactWindow).toBeDefined();

    for (const invalid of ["300k", "50000"]) {
      expect(
        nextProviderConfigWithFieldValue({ launchArgs: "--x" }, autoCompactWindow!, invalid),
      ).toEqual({ launchArgs: "--x" });
    }
    expect(
      nextProviderConfigWithFieldValue({ launchArgs: "--x" }, autoCompactWindow!, "300000"),
    ).toEqual({ launchArgs: "--x", autoCompactWindow: "300000" });
  });

  it("shows the profile switch only to signed-in Claude accounts and stores it off", () => {
    const claude = providerClients.get(ProviderDriverKind.make("claudeAgent"))!;
    const cliFields = deriveProviderSettingsFields(claude, { setupMode: "cli" });
    const shareProfile = cliFields.find((field) => field.key === "shareProfile")!;
    expect(shareProfile.defaultBooleanValue).toBe(true);
    expect(cliFields.some((field) => field.key === "homePath")).toBe(false);
    const existingFields = deriveProviderSettingsFields(claude);
    expect(existingFields.some((field) => field.key === "shareProfile")).toBe(false);
    expect(existingFields.some((field) => field.key === "homePath")).toBe(true);
    expect(nextProviderConfigWithFieldValue(undefined, shareProfile, false)).toEqual({
      shareProfile: false,
    });
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
