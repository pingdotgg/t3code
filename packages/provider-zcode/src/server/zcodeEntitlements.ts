// @effect-diagnostics nodeBuiltinImport:off -- the CLI's credential store is AES-256-GCM under a key only node:crypto can derive
// The entitlement ladder shared by the model picker and the auth probe: which individual-coding-plan
// families the user selected in setting.json and holds a decryptable login token for in
// credentials.json, joined against the CLI catalog's zhipu-account rules.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import {
  zcodeRecordArray,
  zcodeRecordField,
  zcodeRecordString,
  type ZcodeRecord,
} from "./zcodeProtocol.ts";
import { zcodeDataRoot } from "./zcodeRuntime.ts";

const ENCRYPTED_PREFIX = "enc:v1:";
const CIPHER_ALGORITHM = "aes-256-gcm";

/**
 * The CLI's machine-bound fallback cipher secret: sha256 of this string keys the store's
 * AES-256-GCM values. ZCODE_CREDENTIAL_SECRET overrides it for custom installs.
 */
export const resolveZcodeCredentialSecret = (
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string => {
  const configured = environment.ZCODE_CREDENTIAL_SECRET?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  // The CLI binds the fallback to os.userInfo().username — env USER/USERNAME may be absent in
  // server processes and must not silently derive a different key.
  let username = "unknown";
  try {
    username = NodeOS.userInfo().username;
  } catch {
    username = environment.USER ?? environment.USERNAME ?? "unknown";
  }
  const home = environment.HOME ?? NodeOS.homedir();
  return `zcode-credential-fallback:${platform}:${home}:${username}`;
};

export const decryptZcodeCredential = (value: string, secret: string): string => {
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value;
  const [ivRaw, tagRaw, cipherRaw] = value.slice(ENCRYPTED_PREFIX.length).split(".");
  if (ivRaw === undefined || tagRaw === undefined || cipherRaw === undefined) {
    throw new Error("Encrypted credential is not <iv>.<authTag>.<ciphertext>.");
  }
  const decipher = NodeCrypto.createDecipheriv(
    CIPHER_ALGORITHM,
    NodeCrypto.createHash("sha256").update(secret).digest(),
    Buffer.from(ivRaw, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
};

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const readDecryptedCredentialStore = Effect.fn("ZcodeEntitlements.readCredentialStore")(function* (
  fileSystem: FileSystem.FileSystem,
  credentialsPath: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Effect.fn.Return<Record<string, string>> {
  const raw = yield* fileSystem.readFileString(credentialsPath).pipe(Effect.option);
  if (Option.isNone(raw)) return {};
  const parsed = Option.getOrUndefined(decodeJsonText(raw.value));
  if (!Predicate.isObject(parsed)) return {};
  const secret = resolveZcodeCredentialSecret(environment, platform);
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") continue;
    const decrypted = yield* Effect.try({
      try: () => decryptZcodeCredential(value, secret),
      catch: () => undefined,
    }).pipe(Effect.option);
    if (Option.isSome(decrypted)) entries[key] = decrypted.value;
  }
  return entries;
});

/**
 * Families the entitlement ladder treats as signed-in OAuth individual coding plans: setting.json
 * selects the plan, no apiKey override, and the credential store holds a login token for the
 * family. The provider status probe derives its auth display from this same predicate so the
 * probe and the picker cannot drift.
 */
export const zcodeOAuthSelectedFamilies = (
  setting: unknown,
  store: Record<string, unknown>,
): ReadonlySet<string> => {
  if (!Predicate.isObject(setting)) return new Set<string>();
  const selections = setting["providerFamilyConnectionSelections"];
  const modes = setting["modelProviderFamilyModes"];
  const families = new Set<string>();
  if (!Predicate.isObject(selections)) return families;
  for (const [family, selection] of Object.entries(selections)) {
    const kind = Predicate.isObject(selection) ? selection["kind"] : undefined;
    if (kind !== "individual-coding-plan") continue;
    if (Predicate.isObject(modes) && modes[family] === "apiKey") continue;
    const token = store[`oauth:${family}:access_token`];
    if (typeof token !== "string" || token.length === 0) continue;
    families.add(family);
  }
  return families;
};

/** Families whose 3.15+ connection is an active OAuth individual coding plan. */
const readOAuthSelectedFamilies = Effect.fn("ZcodeEntitlements.readOAuthFamilies")(function* (
  fileSystem: FileSystem.FileSystem,
  settingPath: string,
  store: Record<string, string>,
): Effect.fn.Return<ReadonlySet<string>> {
  const raw = yield* fileSystem.readFileString(settingPath).pipe(Effect.option);
  const parsed = Option.isNone(raw) ? undefined : Option.getOrUndefined(decodeJsonText(raw.value));
  return zcodeOAuthSelectedFamilies(parsed, store);
});

const zcodeRuleAccess = (rule: unknown): ZcodeRecord | undefined => {
  const access = zcodeRecordField(zcodeRecordField(rule, "config"), "access");
  return Predicate.isObject(access) ? access : undefined;
};

const zcodeBuiltinAccountRules = (builtinCatalog: unknown): ReadonlyArray<ZcodeRecord> => {
  const providerRules = zcodeRecordArray(
    zcodeRecordField(zcodeRecordField(builtinCatalog, "config"), "providerConfigRules"),
    "providerRules",
  );
  return (providerRules ?? []).filter(
    (rule): rule is ZcodeRecord =>
      Predicate.isObject(rule) &&
      zcodeRecordString(zcodeRuleAccess(rule), "type") === "zhipu-account",
  );
};

const zcodeBuiltinModelIds = (rule: ZcodeRecord): ReadonlyArray<string> => {
  const ids = zcodeRecordField(zcodeRecordField(rule, "config"), "builtinModelIds");
  return (Array.isArray(ids) ? ids : []).filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
};

/**
 * Entitled individual-coding-plan models for the model picker: enumerated from the injected
 * catalog plus the entitlement ladder, so a catalog refresh by the CLI adds models without an
 * adapter change. Reasoning levels come from the catalog's modelRules (modelMatch regexes,
 * matched case-insensitively against the model id).
 */
export interface ZcodeEntitledModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly reasoningLevels: ReadonlyArray<string>;
}

export const zcodeEntitledModels = Effect.fn("ZcodeEntitlements.entitledModels")(function* (
  fileSystem: FileSystem.FileSystem,
  input: {
    readonly builtinPath: string;
    readonly builtinCatalog: unknown;
    readonly environment: NodeJS.ProcessEnv;
  },
): Effect.fn.Return<ReadonlyArray<ZcodeEntitledModel>, never, never> {
  const rules = zcodeBuiltinAccountRules(input.builtinCatalog);
  const root = zcodeDataRoot(input.environment);
  if (rules.length === 0 || root === undefined) return [];
  const store = yield* readDecryptedCredentialStore(
    fileSystem,
    `${root}/.zcode/v2/credentials.json`,
    input.environment,
    yield* HostProcess.Platform,
  );
  const families = yield* readOAuthSelectedFamilies(
    fileSystem,
    `${root}/.zcode/v2/setting.json`,
    store,
  );
  const modelRules = zcodeRecordArray(
    zcodeRecordField(zcodeRecordField(input.builtinCatalog, "config"), "modelConfigRules"),
    "modelRules",
  );
  const levelsFor = (modelId: string): ReadonlyArray<string> => {
    // Later matching rules compose over earlier ones (the runtime's advertised levels are the
    // last match: Flash hits glm-5.* then glm-5\.3, landing on [low, high, max]).
    let levels: ReadonlyArray<string> = [];
    for (const rule of modelRules ?? []) {
      const match = zcodeRecordString(rule, "modelMatch");
      if (match === undefined) continue;
      let regex: RegExp;
      try {
        regex = new RegExp(match, "i");
      } catch {
        continue;
      }
      if (!regex.test(modelId)) continue;
      const specs = zcodeRecordField(zcodeRecordField(rule, "config"), "optionSpecs");
      const reasoning = zcodeRecordField(Predicate.isObject(specs) ? specs : {}, "reasoningLevel");
      const values = zcodeRecordArray(reasoning, "values")?.filter(
        (value): value is string => typeof value === "string",
      );
      if (values !== undefined && values.length > 0) levels = values;
    }
    return levels;
  };
  const out: Array<ZcodeEntitledModel> = [];
  for (const rule of rules) {
    const providerId = zcodeRecordString(rule, "providerId");
    const access = zcodeRuleAccess(rule);
    if (
      providerId === undefined ||
      zcodeRecordString(access, "mode") !== "individual-coding-plan" ||
      !families.has(zcodeRecordString(access, "accountType") ?? "")
    ) {
      continue;
    }
    for (const modelId of zcodeBuiltinModelIds(rule)) {
      out.push({ providerId, modelId, reasoningLevels: levelsFor(modelId) });
    }
  }
  return out;
});
