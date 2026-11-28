import {
  GmailClientId,
  LocalVaultName,
  LocalVaultRecord,
  VAULT_TOKEN_SERVICES,
  VaultConnectionRevision,
  VaultConnectionSecretText,
  VaultTokenService,
  vaultMentionLabel,
  type LocalVaultInput,
  type LocalVaultResult,
  type LocalVaultEntry,
  type LocalVaultField,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
class InvalidVaultEntry extends Schema.TaggedError<InvalidVaultEntry>()("InvalidVaultEntry", {}) {}
import { SecretStoreEncodeError, type ServerSecretStore } from "../auth/ServerSecretStore.ts";
import type { GmailClientRegistration, GmailGrant } from "./GmailApi.ts";
import { gmailCallbackSetup, gmailDefaultRedirectUri } from "./GmailCallback.ts";
import { verifyServiceIdentity, type ServiceConnection } from "./ServiceConnections.ts";
import {
  authorizeVaultUse,
  isVaultAccessError,
  newVaultEpoch,
  setVaultPin,
  vaultSecuritySummary,
  withVaultEdit,
} from "./VaultAccess.ts";

const isInvalidVaultEntry = Schema.is(InvalidVaultEntry);
class VaultEditError extends Schema.TaggedError<VaultEditError>()("VaultEditError", {
  message: Schema.String,
}) {}
const isVaultEditError = Schema.is(VaultEditError);
const isVaultName = Schema.is(LocalVaultName);
const isVaultRecord = Schema.is(LocalVaultRecord);
const isGmailClientId = Schema.is(GmailClientId);
const isConnectionSecretText = Schema.is(VaultConnectionSecretText);
type StoredRecord = LocalVaultRecord & {
  readonly serviceConnection?: ServiceConnection;
  readonly gmailClient?: GmailClientRegistration;
  readonly gmailGrant?: GmailGrant;
  readonly gmailGrantRevision?: string;
};
const grantText = Schema.String.check(Schema.isMinLength(1));
const connectionSchema = Schema.Struct({
  service: VaultTokenService,
  account: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(254)),
  token: VaultConnectionSecretText,
  revision: VaultConnectionRevision,
});
const decodeConnection = Schema.decodeUnknownSync(connectionSchema);
const clientSchema = Schema.Struct({
  clientId: GmailClientId,
  clientSecret: VaultConnectionSecretText,
  redirectUri: grantText,
  revision: grantText,
});
const grantSchema = Schema.Struct({
  account: grantText,
  refreshToken: grantText,
  clientId: grantText,
});
const decodeGrant = Schema.decodeUnknownSync(grantSchema);
const decodeClient = Schema.decodeUnknownSync(clientSchema);
const encodeStoredRecord = Schema.encodeEffect(
  Schema.fromJsonString(
    LocalVaultRecord.mapMembers((members) =>
      members.map(({ fields }) =>
        Schema.Struct({
          ...fields,
          serviceConnection: Schema.optionalKey(connectionSchema),
          gmailClient: Schema.optionalKey(clientSchema),
          gmailGrant: Schema.optionalKey(grantSchema),
          gmailGrantRevision: Schema.optionalKey(grantText),
        }),
      ),
    ),
  ),
);
const prefix = "vault-entry-";
const writes = Semaphore.makeUnsafe(1);
const decodeRecord = Schema.decodeUnknownSync(LocalVaultRecord);
function vaultRecord(raw: string, name: string): StoredRecord {
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    // Never hand a truncated structured credential to an ordinary token consumer.
    if (
      /^\s*\{/u.test(raw) &&
      /"(?:gmailGrant|gmailClient|serviceConnection)"\s*:|"kind"\s*:\s*"(?:gmail|service)"/u.test(
        raw,
      )
    )
      throw new InvalidVaultEntry();
    return { version: 1, kind: "token", title: name, token: raw };
  }
  if (
    typeof record === "object" &&
    record !== null &&
    "version" in record &&
    record.version === 1
  ) {
    const entry = decodeRecord(record);
    if (entry.kind === "service") {
      if (!("serviceConnection" in record) || "gmailClient" in record || "gmailGrant" in record)
        throw new InvalidVaultEntry();
      return { ...entry, serviceConnection: decodeConnection(record.serviceConnection) };
    }
    if ("serviceConnection" in record) throw new InvalidVaultEntry();
    // Older publisher-backed grants are not evidence of consent to an owner's client.
    // Keep the slot and its ordinary credential fields so the owner can reconnect or delete it.
    if (!("gmailClient" in record)) return entry;
    const gmailClient = decodeClient(record.gmailClient);
    if (
      "gmailGrant" in record &&
      "gmailGrantRevision" in record &&
      record.gmailGrantRevision === gmailClient.revision &&
      Schema.is(grantSchema)(record.gmailGrant) &&
      record.gmailGrant.clientId === gmailClient.clientId
    )
      return {
        ...entry,
        gmailClient,
        gmailGrant: record.gmailGrant,
        gmailGrantRevision: gmailClient.revision,
      };
    return { ...entry, gmailClient };
  }
  // A grant-bearing record of an unsupported version is not a legacy API token.
  if (
    typeof record === "object" &&
    record !== null &&
    ("gmailGrant" in record ||
      "gmailClient" in record ||
      "serviceConnection" in record ||
      ("kind" in record && (record.kind === "gmail" || record.kind === "service")))
  )
    throw new InvalidVaultEntry();
  return { version: 1, kind: "token", title: name, token: raw };
}
function vaultEntry(name: string, record: StoredRecord): LocalVaultEntry {
  return {
    name,
    title: record.title,
    kind: record.kind,
    fields:
      record.kind === "login"
        ? ["username", "password"]
        : record.kind === "token"
          ? ["token"]
          : record.kind === "note"
            ? ["note"]
            : [],
    ...(record.kind === "login" ? { origin: record.origin } : {}),
    ...(record.gmailClient
      ? {
          gmailClient: {
            clientId: record.gmailClient.clientId,
            redirectUri: record.gmailClient.redirectUri,
          },
        }
      : {}),
    ...(record.gmailGrant ? { gmailAccount: record.gmailGrant.account } : {}),
    ...(record.serviceConnection
      ? {
          serviceConnection: {
            service: record.serviceConnection.service,
            account: record.serviceConnection.account,
            revision: record.serviceConnection.revision,
          },
        }
      : {}),
  };
}
export const readVaultRecord = Effect.fn("LocalVault.readRecord")(
  function* (store: ServerSecretStore["Service"] | undefined, name: string) {
    if (!store || store.storageMode !== "linux-keyring-aes256gcm" || !isVaultName(name))
      return undefined;
    const value = yield* store.get(`${prefix}${name}`);
    if (Option.isNone(value)) return undefined;
    try {
      return yield* Effect.try({
        try: () => vaultRecord(new TextDecoder().decode(value.value), name),
        catch: () => new InvalidVaultEntry(),
      });
    } finally {
      value.value.fill(0);
    }
  },
  Effect.orElseSucceed(() => undefined),
);
export function vaultField(record: LocalVaultRecord, field: LocalVaultField): string | undefined {
  if (record.kind === "token" && field === "token") return record.token;
  if (record.kind === "note" && field === "note") return record.note;
  if (record.kind === "login" && (field === "username" || field === "password"))
    return record[field];
  return undefined;
}
export function vaultOriginMatches(record: LocalVaultRecord, target: string | undefined): boolean {
  if (record.kind !== "login") return true;
  try {
    const url = new URL(target ?? "");
    return (
      url.protocol === "https:" && !url.username && !url.password && url.origin === record.origin
    );
  } catch {
    return false;
  }
}
function prepareStructuredRecord(
  raw: string,
  replace: boolean,
  previous: StoredRecord | undefined,
): LocalVaultRecord {
  const candidate = JSON.parse(raw);
  if (
    candidate?.kind === "gmail" ||
    candidate?.kind === "service" ||
    (candidate &&
      ["gmailClient", "gmailGrant", "gmailGrantRevision", "serviceConnection"].some((key) =>
        Object.hasOwn(candidate, key),
      ))
  )
    throw new InvalidVaultEntry();
  if (replace) {
    if (!previous || candidate?.kind !== previous.kind) throw new Error("Entry changed");
    for (const field of ["token", "username", "password", "note"] as const) {
      if (field in previous && candidate[field] === "")
        candidate[field] = vaultField(previous, field);
    }
  }
  let record = decodeRecord(candidate);
  if (record.kind === "login") {
    const url = new URL(record.origin);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Invalid website");
    record = { ...record, origin: url.origin };
  }
  return record;
}
const listNames = Effect.fn("LocalVault.listNames")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.readDirectory(directory))
    .filter((name) => /^vault-entry-[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.bin$/.test(name))
    .map((name) => name.slice(prefix.length, -4))
    .sort();
});

const requireUniqueTitle = Effect.fn("LocalVault.requireUniqueTitle")(function* (
  store: ServerSecretStore["Service"],
  directory: string,
  name: string,
  title: string,
) {
  const label = vaultMentionLabel(title);
  if (!label) return yield* new InvalidVaultEntry();
  for (const other of yield* listNames(directory)) {
    if (other === name) continue;
    const record = yield* readVaultRecord(store, other);
    if (!record) return yield* new VaultEditError({ message: "An entry could not be read." });
    if (vaultMentionLabel(record.title) === label)
      return yield* new VaultEditError({ message: "Another vault entry already uses that title." });
  }
});

const writeRecord = Effect.fn("LocalVault.writeRecord")(function* (
  store: ServerSecretStore["Service"],
  name: string,
  record: StoredRecord,
  replace: boolean,
) {
  const raw = yield* encodeStoredRecord(record).pipe(
    Effect.mapError(() => new SecretStoreEncodeError({ resource: "vault entry", cause: null })),
  );
  const bytes = new TextEncoder().encode(raw);
  try {
    if (replace) yield* store.set(`${prefix}${name}`, bytes);
    else yield* store.create(`${prefix}${name}`, bytes);
  } finally {
    bytes.fill(0);
  }
});

const connectService = Effect.fn("LocalVault.connectService")(function* (
  store: ServerSecretStore["Service"],
  directory: string,
  input: Extract<LocalVaultInput, { action: "connect-service" }>,
) {
  if (
    !isVaultName(input.name) ||
    !isVaultRecord({ kind: "service", version: 1, title: input.title })
  )
    return yield* new InvalidVaultEntry();

  const { epoch, replace } = yield* writes.withPermits(1)(
    Effect.gen(function* () {
      // Authorization wipes its handle. Keep the original solely for the final write check.
      const epoch = yield* authorizeVaultUse(
        store,
        input.name,
        "tagged",
        Redacted.make(Redacted.value(input.pin)),
      );
      const previous = yield* readVaultRecord(store, input.name);
      const fs = yield* FileSystem.FileSystem;
      if (previous) {
        if (previous.kind !== "service" || previous.serviceConnection?.service !== input.service)
          return yield* new VaultEditError({
            message: "This vault entry is already used by another credential.",
          });
      } else if (yield* fs.exists(`${directory}/${prefix}${input.name}.bin`)) {
        return yield* new VaultEditError({ message: "An entry could not be read." });
      }
      yield* requireUniqueTitle(store, directory, input.name, input.title);
      return { epoch, replace: previous !== undefined };
    }),
  );

  // No vault or policy lock is held during the outbound request.
  const token = Redacted.value(input.token);
  const account = yield* verifyServiceIdentity(input.service, token).pipe(
    Effect.mapError((error) => new VaultEditError({ message: error.message })),
  );
  yield* writes.withPermits(1)(
    Effect.gen(function* () {
      if ((yield* vaultSecuritySummary(store)).epoch !== epoch)
        return yield* new VaultEditError({
          message: "The vault changed while verifying the credential. Try again.",
        });
      yield* withVaultEdit(
        store,
        input.pin,
        input.name,
        "ask",
        writeRecord(
          store,
          input.name,
          {
            version: 1,
            kind: "service",
            title: input.title,
            serviceConnection: {
              service: input.service,
              account,
              token,
              revision: newVaultEpoch(),
            },
          },
          replace,
        ),
      );
    }),
  );
});

function vaultErrorMessage(error: unknown): string {
  return isVaultAccessError(error) || isVaultEditError(error)
    ? error.message
    : isInvalidVaultEntry(error)
      ? "Check the entry fields and HTTPS website address, then try again."
      : "Could not update the vault. Check whether the name already exists and that the vault is available.";
}

type GmailEdit = { readonly name: string; readonly pin: Redacted.Redacted<string> };
type GmailConnect = GmailEdit & {
  readonly title: string;
  readonly grant: GmailGrant;
  readonly expectedClientRevision: string;
};

// Use the same mutation lock as ordinary entry edits, including the read/merge and PIN check.
const editVaultGmail = Effect.fn("LocalVault.editGmail")(
  function* (store: ServerSecretStore["Service"] | undefined, input: GmailEdit | GmailConnect) {
    if (!store?.directory || store.storageMode !== "linux-keyring-aes256gcm")
      return yield* new VaultEditError({ message: "Connect to an encrypted Hyakki vault." });
    if (!isVaultName(input.name)) return yield* new InvalidVaultEntry();
    const directory = store.directory;
    return yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const previous = yield* readVaultRecord(store, input.name);
        if (!previous?.gmailClient)
          return yield* new VaultEditError({
            message: "Configure this entry's Google OAuth client first.",
          });
        let next: StoredRecord;
        if ("grant" in input) {
          if (previous.title !== input.title)
            return yield* new VaultEditError({ message: "The vault entry title has changed." });
          if (
            previous.gmailClient.revision !== input.expectedClientRevision ||
            previous.gmailClient.clientId !== input.grant.clientId
          )
            return yield* new VaultEditError({
              message: "The Google OAuth client changed. Reconnect this entry.",
            });
          next = yield* Effect.try({
            try: () => ({
              ...previous,
              gmailGrantRevision: input.expectedClientRevision,
              gmailGrant: decodeGrant(input.grant),
            }),
            catch: () => new InvalidVaultEntry(),
          });
          yield* requireUniqueTitle(store, directory, input.name, input.title);
        } else {
          // Rotate even when there's no saved grant: disconnect also revokes an in-flight exchange.
          const { gmailGrant: _grant, gmailGrantRevision: _revision, ...entry } = previous;
          next = {
            ...entry,
            gmailClient: { ...previous.gmailClient, revision: newVaultEpoch() },
          };
        }
        const { rules } = yield* vaultSecuritySummary(store);
        const access = Object.hasOwn(rules, input.name) ? rules[input.name] : undefined;
        yield* withVaultEdit(
          store,
          input.pin,
          input.name,
          access,
          writeRecord(store, input.name, next, true),
        );
      }),
    );
  },
  (effect, _store, input) =>
    effect.pipe(
      Effect.mapError((error) =>
        isVaultAccessError(error) || isVaultEditError(error)
          ? error
          : new VaultEditError({ message: "Could not update the Gmail connection in the vault." }),
      ),
      Effect.ensuring(Effect.sync(() => Redacted.wipeUnsafe(input.pin))),
    ),
);
export const setVaultGmailGrant = (
  store: ServerSecretStore["Service"] | undefined,
  input: GmailConnect,
) => editVaultGmail(store, input);
export const disconnectVaultGmail = (
  store: ServerSecretStore["Service"] | undefined,
  input: GmailEdit,
) => editVaultGmail(store, { name: input.name, pin: input.pin });

export const manageLocalVault = Effect.fn("LocalVault.manage")(
  function* (
    store: ServerSecretStore["Service"] | undefined,
    input: LocalVaultInput,
    options: { readonly canSetInitialPin?: boolean } = {},
  ): Effect.fn.Return<LocalVaultResult, never, FileSystem.FileSystem> {
    if (!store?.directory || store.storageMode !== "linux-keyring-aes256gcm")
      return {
        names: [],
        entries: [],
        error: "Connect to an environment with an encrypted Hyakki vault.",
      };
    if (
      input.action === "gmail-start" ||
      input.action === "gmail-finish" ||
      input.action === "gmail-disconnect"
    )
      return {
        names: [],
        entries: [],
        error: "Use the Gmail connection settings for this action.",
      };
    const directory = store.directory;
    if (input.action === "connect-service") {
      const error = yield* connectService(store, directory, input).pipe(
        Effect.match({ onFailure: vaultErrorMessage, onSuccess: () => null }),
      );
      if (error !== null) return { names: [], entries: [], error };
    }
    return yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const gmailRedirectUri = Option.getOrUndefined(
          yield* Effect.option(gmailDefaultRedirectUri()),
        );
        if (input.action === "save") {
          const raw = Redacted.value(input.value);
          const previous = input.replace ? yield* readVaultRecord(store, input.name) : undefined;
          if (input.replace && !previous) return yield* new InvalidVaultEntry();
          if (!input.structured && previous && previous.kind !== "token")
            return yield* new InvalidVaultEntry();
          const record = input.structured
            ? yield* Effect.try({
                try: () => prepareStructuredRecord(raw, input.replace, previous),
                catch: () => new InvalidVaultEntry(),
              })
            : {
                version: 1 as const,
                kind: "token" as const,
                title: previous?.title ?? input.name,
                token: raw,
              };
          if (!previous || previous.title !== record.title)
            yield* requireUniqueTitle(store, directory, input.name, record.title);
          yield* withVaultEdit(
            store,
            input.pin,
            input.name,
            input.access ?? "ask",
            writeRecord(store, input.name, { ...previous, ...record }, input.replace),
          );
        } else if (input.action === "gmail-configure") {
          if (!gmailRedirectUri) return yield* new VaultEditError({ message: gmailCallbackSetup });
          if (
            !isVaultName(input.name) ||
            !isGmailClientId(input.clientId) ||
            input.redirectUri !== gmailRedirectUri
          )
            return yield* new VaultEditError({
              message:
                "Check the Google client ID and use the exact callback URL shown in Settings.",
            });
          const previous = yield* readVaultRecord(store, input.name);
          if (previous?.kind === "service")
            return yield* new VaultEditError({
              message: "This entry already holds a service credential.",
            });
          if (previous && previous.title !== input.title)
            return yield* new VaultEditError({ message: "The vault entry title has changed." });
          yield* requireUniqueTitle(store, directory, input.name, input.title);
          const existing = previous?.gmailClient;
          const secret = input.clientSecret
            ? Redacted.value(input.clientSecret)
            : existing?.clientId === input.clientId
              ? existing.clientSecret
              : undefined;
          if (!isConnectionSecretText(secret))
            return yield* new VaultEditError({
              message: "Enter the client secret for this Google client ID.",
            });
          if (
            existing?.clientId === input.clientId &&
            existing.clientSecret === secret &&
            existing.redirectUri === input.redirectUri
          ) {
            yield* authorizeVaultUse(store, input.name, "tagged", input.pin);
          } else {
            const base: StoredRecord = previous ?? {
              version: 1,
              kind: "gmail",
              title: input.title,
            };
            const { gmailGrant: _grant, gmailGrantRevision: _revision, ...entry } = base;
            const gmailClient = {
              clientId: input.clientId,
              clientSecret: secret,
              redirectUri: input.redirectUri,
              revision: newVaultEpoch(),
            };
            const { rules } = yield* vaultSecuritySummary(store);
            yield* withVaultEdit(
              store,
              input.pin,
              input.name,
              previous && Object.hasOwn(rules, input.name) ? rules[input.name] : undefined,
              writeRecord(store, input.name, { ...entry, gmailClient }, !!previous),
            );
          }
        } else if (input.action === "remove") {
          yield* withVaultEdit(
            store,
            input.pin,
            input.name,
            undefined,
            store.remove(`${prefix}${input.name}`),
          );
        } else if (input.action === "set-pin") {
          yield* setVaultPin(store, input.newPin, input.pin, options.canSetInitialPin === true);
        }
        const policy = yield* vaultSecuritySummary(store);
        const security = {
          configured: policy.configured,
          canSetInitialPin: options.canSetInitialPin === true,
          retryAt: policy.retryAt,
        };
        const names = yield* listNames(directory);
        const entries: LocalVaultEntry[] = [];
        for (const name of names) {
          const record = yield* readVaultRecord(store, name);
          if (!record)
            return {
              names: [],
              entries: [],
              error: "An entry could not be read. Check the OS keyring and retry.",
            };
          entries.push({
            ...vaultEntry(name, record),
            access: (Object.hasOwn(policy.rules, name) ? policy.rules[name] : "ask") ?? "ask",
          });
        }
        return {
          names,
          entries,
          security,
          credentialServices: ["gmail", ...VAULT_TOKEN_SERVICES] as const,
          gmailAvailable: true,
          gmailUserCredentials: true as const,
          ...(gmailRedirectUri === undefined ? {} : { gmailRedirectUri }),
          error: null,
        };
      }).pipe(
        Effect.orElseSucceed((error) => ({
          names: [],
          entries: [],
          error: vaultErrorMessage(error),
        })),
      ),
    );
  },
  (effect, _store, input, _options?: { readonly canSetInitialPin?: boolean }) =>
    effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (input.action === "save") Redacted.wipeUnsafe(input.value);
          if (input.action === "connect-service") Redacted.wipeUnsafe(input.token);
          if (input.action === "gmail-configure" && input.clientSecret)
            Redacted.wipeUnsafe(input.clientSecret);
          if ("pin" in input && input.pin) Redacted.wipeUnsafe(input.pin);
          if (input.action === "set-pin") Redacted.wipeUnsafe(input.newPin);
        }),
      ),
    ),
);
