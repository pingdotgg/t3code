// @effect-diagnostics nodeBuiltinImport:off -- the push revision hashes the injected catalog path with sha256
// Account provisioning and request auth for the ZCode CLI: the entitlement ladder behind the
// `provider/updateAccountConfig` push, and the OAuth project-token exchange that answers
// `interaction/requestProviderRuntimeHeaders` before every account-model request. Verified
// end-to-end against zcode 3.17.2 (PROTOCOL-NOTES.md); the desktop host performs the same
// exchanges.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import { causeErrorTag } from "@t3tools/shared/observability";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  zcodeJsonStringify,
  zcodeRecordArray,
  zcodeRecordField,
  zcodeRecordString,
  type ZcodeRecord,
} from "./zcodeProtocol.ts";
import { zcodeDataRoot } from "./zcodeRuntime.ts";

const ENCRYPTED_PREFIX = "enc:v1:";
const CIPHER_ALGORITHM = "aes-256-gcm";
const ZCODE_JWT_CREDENTIAL_KEY = "zcodejwttoken";
const ZCODE_API_KEY_NAME = "zcode-api-key";
const TEAM_PROJECT_TYPE = "2";
const DEFAULT_ORGANIZATION_NAME = "默认机构";
const DEFAULT_PROJECT_NAME = "默认项目";
const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_TTL_MS = 10 * 60_000;
/** Refresh the cached project token this long before expiry so a queued request never stalls. */
const TOKEN_REFRESH_MARGIN_MS = 120_000;

const FAMILY_ORIGIN: Record<string, string> = {
  zai: "https://api.z.ai",
  bigmodel: "https://bigmodel.cn",
};

const sha256Hex = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

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
  const username = environment.USER ?? environment.USERNAME ?? "unknown";
  const home = environment.HOME ?? "";
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

const readDecryptedCredentialStore = Effect.fn("ZcodeRequestAuth.readCredentialStore")(function* (
  fileSystem: FileSystem.FileSystem,
  credentialsPath: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Effect.fn.Return<Record<string, string>> {
  const raw = yield* fileSystem.readFileString(credentialsPath).pipe(Effect.option);
  const parsed = Option.isNone(raw) ? undefined : Option.getOrUndefined(decodeJsonText(raw.value));
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

/** Families whose 3.15+ connection is an active OAuth individual coding plan. */
const readOAuthSelectedFamilies = Effect.fn("ZcodeRequestAuth.readOAuthFamilies")(function* (
  fileSystem: FileSystem.FileSystem,
  settingPath: string,
  store: Record<string, string>,
): Effect.fn.Return<ReadonlySet<string>> {
  const raw = yield* fileSystem.readFileString(settingPath).pipe(Effect.option);
  const parsed = Option.isNone(raw) ? undefined : Option.getOrUndefined(decodeJsonText(raw.value));
  if (!Predicate.isObject(parsed)) return new Set<string>();
  const selections = parsed["providerFamilyConnectionSelections"];
  const modes = parsed["modelProviderFamilyModes"];
  const families = new Set<string>();
  if (!Predicate.isObject(selections)) return families;
  for (const [family, selection] of Object.entries(selections)) {
    const kind = Predicate.isObject(selection) ? selection["kind"] : undefined;
    if (kind !== "individual-coding-plan") continue;
    if (Predicate.isObject(modes) && modes[family] === "apiKey") continue;
    if (!store[`oauth:${family}:access_token`]) continue;
    families.add(family);
  }
  return families;
});

export type ZcodeAccountProviderPush = {
  readonly builtinModelIds: ReadonlyArray<string>;
  readonly access: { readonly type: "zhipu-account"; readonly entitled: boolean };
};

export type ZcodeAccountStatePush = {
  readonly availability: "available" | "unavailable";
  readonly entitled: boolean;
  readonly current: boolean;
};

export type ZcodeAccountConfigPush = {
  readonly revision: string;
  readonly basedOnZCodeBuiltinRevision: string;
  readonly providers: Record<string, ZcodeAccountProviderPush>;
  readonly states: Record<string, ZcodeAccountStatePush>;
};

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

/** The registry keys the snapshot to `zcode-builtin:<revision>:<sha256(path)>` of the catalog
 * file the CLI booted from; any other value is accepted and silently ignored. */
const zcodeBuiltinBasedOnRevision = (builtinPath: string, builtinCatalog: unknown): string => {
  const revision = zcodeRecordField(builtinCatalog, "revision");
  const revisionText =
    typeof revision === "number" && Number.isFinite(revision)
      ? String(Math.trunc(revision))
      : typeof revision === "string" && revision.length > 0
        ? revision
        : "0";
  return `zcode-builtin:${revisionText}:${sha256Hex(NodePath.resolve(builtinPath))}`;
};

/**
 * Builds the `provider/updateAccountConfig` push from the builtin catalog's zhipu-account rules
 * and the entitlement ladder: a family is entitled only when the user picked an OAuth
 * individual coding plan for it and the credential store decrypts to its login token.
 */
export const zcodeAccountConfigPushFromLadder = Effect.fn("ZcodeRequestAuth.buildAccountPush")(
  function* (
    fileSystem: FileSystem.FileSystem,
    input: {
      readonly builtinPath: string;
      readonly builtinCatalog: unknown;
      readonly environment: NodeJS.ProcessEnv;
    },
  ): Effect.fn.Return<ZcodeAccountConfigPush | undefined> {
    const rules = zcodeBuiltinAccountRules(input.builtinCatalog);
    if (rules.length === 0) return undefined;
    const root = zcodeDataRoot(input.environment);
    if (root === undefined) return undefined;
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
    const providers: Record<string, ZcodeAccountProviderPush> = {};
    const states: Record<string, ZcodeAccountStatePush> = {};
    for (const rule of rules) {
      const providerId = zcodeRecordString(rule, "providerId");
      const modelIds = zcodeBuiltinModelIds(rule);
      if (providerId === undefined || modelIds.length === 0) continue;
      const entitled =
        zcodeRecordString(zcodeRuleAccess(rule), "mode") === "individual-coding-plan" &&
        families.has(zcodeRecordString(zcodeRuleAccess(rule), "accountType") ?? "");
      providers[providerId] = {
        builtinModelIds: modelIds,
        access: { type: "zhipu-account", entitled },
      };
      states[providerId] = {
        availability: entitled ? "available" : "unavailable",
        entitled,
        current: entitled,
      };
    }
    if (Object.keys(providers).length === 0) return undefined;
    return {
      revision: `account:t3code:${DateTime.toEpochMillis(yield* DateTime.now)}`,
      basedOnZCodeBuiltinRevision: zcodeBuiltinBasedOnRevision(
        input.builtinPath,
        input.builtinCatalog,
      ),
      providers,
      states,
    };
  },
);

/** `account:<family>-individual-coding-plan` → the plan family the auth exchange needs. */
export const zcodeFamilyFromProviderId = (providerId: string | undefined): string | undefined => {
  const family = providerId?.replace(/^account:/, "").replace(/-individual-coding-plan$/, "");
  return family === undefined || family.length === 0 ? undefined : family;
};

/** Mirrors the CLI's account-scope digest over the plan identity and login tokens. */
export const zcodeAccountScope = (
  family: string,
  loginToken: string,
  jwtToken: string | undefined,
): string =>
  sha256Hex(
    zcodeJsonStringify([family, "individual-coding-plan", null, loginToken, jwtToken ?? null]),
  );

class ZcodeRequestAuthError extends Schema.TaggedError<ZcodeRequestAuthError>()(
  "ZcodeRequestAuthError",
  { message: Schema.String },
) {}

const declineMessage = (hint: string): string => `ZCode request auth failed (${hint}).`;

const failAuth = (hint: string) => new ZcodeRequestAuthError({ message: declineMessage(hint) });

interface CachedProjectToken {
  readonly token: string;
  readonly apiKeyId: string;
  readonly accountScope: string;
  readonly fingerprint: string;
  readonly refreshAtMillis: number;
}

export interface ZcodeRequestAuth {
  /** The `interaction/requestProviderRuntimeHeaders` response for an entitled account model. */
  readonly answerRuntimeHeaders: (input: {
    readonly family: string;
    readonly rejectedProjectTokenFingerprint?: string;
  }) => Effect.Effect<ZcodeRecord>;
}

export interface ZcodeRequestAuthOptions {
  readonly fileSystem: FileSystem.FileSystem;
  readonly httpClient: HttpClient.HttpClient;
  readonly environment: NodeJS.ProcessEnv;
  readonly clientVersion: string;
}

/**
 * Serves OAuth project tokens for entitled individual coding plans, mirroring the desktop
 * host's exchange: customer info → personal default project → the account's `zcode-api-key` →
 * a short-lived access token. Read-only towards the account; a missing key surfaces as a
 * decline the turn reports honestly.
 */
export const makeZcodeRequestAuth = (options: ZcodeRequestAuthOptions): ZcodeRequestAuth => {
  const root = zcodeDataRoot(options.environment) ?? "";
  const credentialsPath = `${root}/.zcode/v2/credentials.json`;
  const cache = new Map<string, CachedProjectToken>();

  const requestJson = (request: HttpClientRequest.HttpClientRequest) =>
    options.httpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeoutOption(REQUEST_TIMEOUT_MS),
      Effect.map((answered) => (Option.isSome(answered) ? answered.value : undefined)),
      Effect.orElseSucceed(() => undefined),
    );

  const envelopeData = Effect.fnUntraced(function* (
    raw: unknown,
    exchange: string,
  ): Effect.fn.Return<unknown, ZcodeRequestAuthError> {
    const code = Predicate.isObject(raw) ? raw["code"] : undefined;
    if (!(code === 0 || code === 200 || code === "0" || code === "200")) {
      return yield* failAuth(`${exchange} code=${String(code)}`);
    }
    return Predicate.isObject(raw) ? raw["data"] : undefined;
  });

  const mint = Effect.fn("ZcodeRequestAuth.mint")(function* (
    family: string,
  ): Effect.fn.Return<CachedProjectToken, ZcodeRequestAuthError> {
    const store = yield* readDecryptedCredentialStore(
      options.fileSystem,
      credentialsPath,
      options.environment,
      yield* HostProcess.Platform,
    );
    const loginToken = store[`oauth:${family}:access_token`];
    if (loginToken === undefined || loginToken.length === 0) {
      return yield* failAuth("no OAuth login for family");
    }
    const origin = FAMILY_ORIGIN[family];
    if (origin === undefined) {
      return yield* failAuth(`unknown family ${family}`);
    }
    const customer = yield* envelopeData(
      yield* requestJson(
        HttpClientRequest.get(`${origin}/api/biz/customer/getCustomerInfo`, {
          headers: { Authorization: loginToken },
        }),
      ),
      "getCustomerInfo",
    );
    const organizations: Array<{
      organizationId: string;
      organizationName?: string;
      projects: Array<{ projectId: string; projectName?: string }>;
    }> = [];
    const rawOrganizations = Predicate.isObject(customer) ? customer["organizations"] : undefined;
    for (const rawOrg of Array.isArray(rawOrganizations) ? rawOrganizations : []) {
      if (!Predicate.isObject(rawOrg)) continue;
      const organizationId = zcodeRecordString(rawOrg, "organizationId");
      if (organizationId === undefined || organizationId.length === 0) continue;
      const projects: Array<{ projectId: string; projectName?: string }> = [];
      const rawProjects = zcodeRecordField(rawOrg, "projects");
      for (const rawProject of Array.isArray(rawProjects) ? rawProjects : []) {
        if (!Predicate.isObject(rawProject)) continue;
        const projectId = zcodeRecordString(rawProject, "projectId");
        if (projectId === undefined || projectId.length === 0) continue;
        if (String(zcodeRecordField(rawProject, "projectType") ?? "").trim() === TEAM_PROJECT_TYPE)
          continue;
        projects.push({
          projectId,
          ...(typeof rawProject["projectName"] === "string"
            ? { projectName: rawProject["projectName"] }
            : {}),
        });
      }
      if (projects.length === 0) continue;
      organizations.push({
        organizationId,
        ...(typeof rawOrg["organizationName"] === "string"
          ? { organizationName: rawOrg["organizationName"] }
          : {}),
        projects,
      });
    }
    const org =
      organizations.find((entry) => entry.organizationName?.includes(DEFAULT_ORGANIZATION_NAME)) ??
      organizations[0];
    const project =
      org?.projects.find((entry) => entry.projectName?.includes(DEFAULT_PROJECT_NAME)) ??
      org?.projects[0];
    if (org === undefined || project === undefined) {
      return yield* failAuth("no personal project");
    }
    const keysPath = `${origin}/api/biz/v1/organization/${encodeURIComponent(org.organizationId)}/projects/${encodeURIComponent(project.projectId)}/api_keys`;
    const keys = yield* envelopeData(
      yield* requestJson(
        HttpClientRequest.get(keysPath, {
          headers: {
            Authorization: family === "zai" ? `Bearer ${loginToken}` : loginToken,
          },
        }),
      ),
      "api_keys",
    );
    const keyList = Array.isArray(keys) ? keys : [];
    const key = keyList.find(
      (entry) => Predicate.isObject(entry) && entry["name"] === ZCODE_API_KEY_NAME,
    );
    const apiKeyId =
      Predicate.isObject(key) && typeof key["apiKey"] === "string" ? key["apiKey"] : undefined;
    if (apiKeyId === undefined || apiKeyId.length === 0) {
      return yield* failAuth("account has no zcode-api-key; open the ZCode app once");
    }
    const exchangeRequest = HttpClientRequest.post(
      `${keysPath}/${encodeURIComponent(apiKeyId)}/access_tokens`,
      { headers: { Authorization: `Bearer ${loginToken}` } },
    ).pipe(
      HttpClientRequest.bodyText(
        zcodeJsonStringify({ clientType: "zcode", clientVersion: options.clientVersion }),
        "application/json",
      ),
    );
    const exchange = yield* envelopeData(yield* requestJson(exchangeRequest), "access_tokens");
    const token =
      Predicate.isObject(exchange) && typeof exchange["accessToken"] === "string"
        ? exchange["accessToken"]
        : undefined;
    if (token === undefined || token.length === 0) {
      return yield* failAuth("token exchange returned no token");
    }
    const cachedToken: CachedProjectToken = {
      token,
      apiKeyId,
      accountScope: zcodeAccountScope(family, loginToken, store[ZCODE_JWT_CREDENTIAL_KEY]),
      fingerprint: sha256Hex(token),
      refreshAtMillis:
        DateTime.toEpochMillis(yield* DateTime.now) + TOKEN_TTL_MS - TOKEN_REFRESH_MARGIN_MS,
    };
    cache.set(family, cachedToken);
    return cachedToken;
  });

  const answer = Effect.fn("ZcodeRequestAuth.answer")(function* (input: {
    readonly family: string;
    readonly rejectedProjectTokenFingerprint?: string;
  }): Effect.fn.Return<ZcodeRecord> {
    const hit = cache.get(input.family);
    const cached =
      hit !== undefined &&
      DateTime.toEpochMillis(yield* DateTime.now) < hit.refreshAtMillis &&
      (input.rejectedProjectTokenFingerprint === undefined ||
        input.rejectedProjectTokenFingerprint !== hit.fingerprint)
        ? hit
        : undefined;
    if (cached !== undefined) {
      return {
        headersApplied: true,
        requestAuth: {
          apiKey: cached.token,
          apiKeyId: cached.apiKeyId,
          accountScope: cached.accountScope,
        },
      };
    }
    const minted = yield* Effect.result(mint(input.family));
    return Result.isFailure(minted)
      ? { headersApplied: false, errorMessage: minted.failure.message }
      : {
          headersApplied: true,
          requestAuth: {
            apiKey: minted.success.token,
            apiKeyId: minted.success.apiKeyId,
            accountScope: minted.success.accountScope,
          },
        };
  });

  return {
    answerRuntimeHeaders: (input) =>
      answer(input).pipe(
        // Any defect here would strand the CLI's request; decline instead.
        Effect.catchCause((cause) =>
          Effect.succeed({
            headersApplied: false,
            errorMessage: declineMessage(causeErrorTag(cause)),
          } satisfies ZcodeRecord),
        ),
      ),
  };
};
