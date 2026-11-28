import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import * as Redacted from "effect/Redacted";
import * as Option from "effect/Option";
import {
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  WS_METHODS,
  clientRpcRequiredScopes,
  LocalVaultInput,
  SecretProviderId,
  type LocalVaultRecord,
  type VaultTokenService,
  localVaultReference,
  parseLocalVaultReference,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  disconnectVaultGmail,
  manageLocalVault,
  readVaultRecord,
  setVaultGmailGrant,
  vaultField,
  vaultOriginMatches,
} from "./LocalVault.ts";
import { readLocalVaultToken } from "./SecretResolver.ts";
import { setVaultPin, vaultSecuritySummary } from "./VaultAccess.ts";
const PIN = "8472951";
import { ServerSecretStore, SecretStorePersistError } from "../auth/ServerSecretStore.ts";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import { isVaultCiphertext, openVaultValue, sealVaultValue } from "../auth/VaultCipher.ts";
import { ServerConfig } from "../config.ts";

const makeStore = Effect.fn("test.makeVaultStore")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped();
  const cipherKey = new Uint8Array(32).fill(31); // Synthetic key; never consult the OS keyring.
  const storeError = (cause: unknown) =>
    new SecretStorePersistError({ resource: "test entry", cause });
  const store = ServerSecretStore.of({
    directory,
    storageMode: "linux-keyring-aes256gcm",
    get: (key) =>
      fs.exists(`${directory}/${key}.bin`).pipe(
        Effect.flatMap((exists) =>
          exists
            ? fs
                .readFile(`${directory}/${key}.bin`)
                .pipe(
                  Effect.map((value) =>
                    Option.some<Uint8Array>(openVaultValue(cipherKey, key, value)),
                  ),
                )
            : Effect.succeed(Option.none<Uint8Array>()),
        ),
        Effect.mapError(storeError),
      ),
    set: (key, value) =>
      fs
        .writeFile(`${directory}/${key}.bin`, sealVaultValue(cipherKey, key, value))
        .pipe(Effect.mapError(storeError)),
    create: (key, value) =>
      fs
        .writeFile(`${directory}/${key}.bin`, sealVaultValue(cipherKey, key, value), { flag: "wx" })
        .pipe(Effect.mapError(storeError)),
    remove: (key) => fs.remove(`${directory}/${key}.bin`).pipe(Effect.mapError(storeError)),
    getOrCreateRandom: () => Effect.die("unused"),
  });
  yield* setVaultPin(store, Redacted.make(PIN), undefined, true);
  return { store, fs };
});
const save = (
  store: ServerSecretStore["Service"],
  name: string,
  record: LocalVaultRecord,
  replace = false,
) =>
  manageLocalVault(store, {
    action: "save",
    name,
    value: Redacted.make(JSON.stringify(record)),
    structured: true,
    replace,
    access: "allow",
    pin: Redacted.make(PIN),
  });
const token: LocalVaultRecord = {
  version: 1,
  kind: "token",
  title: "GitHub work",
  token: "dummy-sensitive-api-token",
};
const login: LocalVaultRecord = {
  version: 1,
  kind: "login",
  title: "GitHub login",
  origin: "https://github.com/settings",
  username: "dummy@example.test",
  password: "dummy-sensitive-password",
};
const note: LocalVaultRecord = {
  version: 1,
  kind: "note",
  title: "Recovery",
  note: "dummy-sensitive-instructions",
};

it.effect("clears redacted PIN and value handles even when storage is unavailable", () =>
  Effect.gen(function* () {
    const pin = Redacted.make(PIN),
      value = Redacted.make("dummy-sensitive-value");
    yield* manageLocalVault(undefined, {
      action: "save",
      name: "entry",
      value,
      pin,
      replace: false,
    });
    assert.throws(() => Redacted.value(pin));
    assert.throws(() => Redacted.value(value));
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("refuses unavailable or unencrypted storage", () =>
  Effect.gen(function* () {
    assert.isNotNull((yield* manageLocalVault(undefined, { action: "list" })).error);
    const { store } = yield* makeStore();
    assert.isNotNull(
      (yield* manageLocalVault({ ...store, storageMode: "private-files" }, { action: "list" }))
        .error,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("stores typed entries but lists only safe metadata", () =>
  Effect.gen(function* () {
    const { store, fs } = yield* makeStore();
    yield* fs.writeFileString(`${store.directory}/internal-key.bin`, "internal");
    for (const [name, record] of [
      ["github", token],
      ["login", login],
      ["recovery", note],
    ] as const)
      assert.isNull((yield* save(store, name, record)).error);
    const listed = yield* manageLocalVault(store, { action: "list" });
    assert.deepStrictEqual(listed.names, ["github", "login", "recovery"]);
    assert.equal(listed.entries?.find((e) => e.kind === "login")?.origin, "https://github.com");
    for (const value of ["dummy-sensitive", "dummy@example.test", "internal"])
      assert.notInclude(JSON.stringify(listed), value);
    assert.deepStrictEqual(listed.entries?.find((e) => e.kind === "login")?.fields, [
      "username",
      "password",
    ]);
    assert.isNotNull((yield* save(store, "github", token)).error);
    assert.isNull(
      (yield* manageLocalVault(store, {
        action: "remove",
        name: "github",
        pin: Redacted.make(PIN),
      })).error,
    );
    assert.isUndefined(yield* readVaultRecord(store, "github"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("keeps protected fields on metadata edits and refuses type changes", () =>
  Effect.gen(function* () {
    const { store } = yield* makeStore();
    yield* save(store, "login", login);
    assert.isNull(
      (yield* save(
        store,
        "login",
        { ...login, title: "Renamed", username: "", password: "" },
        true,
      )).error,
    );
    const record = yield* readVaultRecord(store, "login");
    assert.equal(record?.title, "Renamed");
    assert.deepInclude(record, { username: login.username, password: login.password });
    assert.isNotNull((yield* save(store, "login", token, true)).error);
    assert.equal((yield* readVaultRecord(store, "login"))?.kind, "login");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("rejects unsafe login websites, malformed entries, and invalid references", () =>
  Effect.gen(function* () {
    const { store } = yield* makeStore();
    for (const origin of [
      "http://github.com",
      "javascript:alert(1)",
      "https://user:password@github.com",
    ]) {
      assert.isNotNull((yield* save(store, "bad", { ...login, origin })).error);
      assert.isUndefined(yield* readVaultRecord(store, "bad"));
    }
    assert.isNotNull(
      (yield* manageLocalVault(store, {
        action: "save",
        name: "bad",
        value: Redacted.make('{"version":1}'),
        structured: true,
        replace: false,
      })).error,
    );
    for (const reference of [
      "hyakki-vault://../password",
      "hyakki-vault://abc/token?raw=1",
      "hyakki-vault://abc/unknown",
    ])
      assert.isUndefined(parseLocalVaultReference(reference));
    assert.isUndefined(yield* readVaultRecord(store, "../internal-key"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect(
  "resolves API references fresh and never uses login or note fields as provider tokens",
  () =>
    Effect.gen(function* () {
      const { store } = yield* makeStore();
      yield* save(store, "github", token);
      yield* save(store, "login", login);
      yield* save(store, "note", note);
      const ref = {
        provider: SecretProviderId.make("hyakki-vault"),
        reference: localVaultReference("github", "token"),
      };
      assert.equal(yield* readLocalVaultToken(store, ref), token.token);
      yield* save(store, "github", { ...token, token: "rotated-dummy-token" }, true);
      assert.equal(yield* readLocalVaultToken(store, ref), "rotated-dummy-token");
      assert.isUndefined(
        yield* readLocalVaultToken(store, {
          ...ref,
          reference: localVaultReference("login", "password"),
        }),
      );
      assert.isUndefined(
        yield* readLocalVaultToken(store, {
          ...ref,
          reference: localVaultReference("note", "note"),
        }),
      );
      yield* manageLocalVault(store, { action: "remove", name: "github", pin: Redacted.make(PIN) });
      assert.isUndefined(yield* readLocalVaultToken(store, ref));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("preserves legacy entries and does not treat corrupt structured entries as tokens", () =>
  Effect.gen(function* () {
    const { store } = yield* makeStore();
    yield* store.create("vault-entry-old", new TextEncoder().encode("legacy-dummy-token"));
    assert.deepInclude(yield* readVaultRecord(store, "old"), {
      kind: "token",
      token: "legacy-dummy-token",
    });
    const jsonToken = JSON.stringify(login);
    yield* manageLocalVault(store, {
      action: "save",
      name: "json-token",
      pin: Redacted.make(PIN),
      value: Redacted.make(jsonToken),
      replace: false,
    });
    assert.deepInclude(yield* readVaultRecord(store, "json-token"), {
      kind: "token",
      token: jsonToken,
    });
    yield* store.create(
      "vault-entry-corrupt",
      new TextEncoder().encode('{"version":1,"kind":"login"}'),
    );
    assert.isUndefined(yield* readVaultRecord(store, "corrupt"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
const grant = {
  account: "reader@example.test",
  clientId: "12345-work.apps.googleusercontent.com",
  refreshToken: "synthetic-private-grant",
};
const callback = "https://vault.example.test/oauth/gmail/callback";
const advertisedCallback = (uri?: string) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown(uri === undefined ? {} : { HYAKKI_GMAIL_REDIRECT_URI: uri }),
  );
const gmailVaultLayer = Layer.merge(NodeServices.layer, advertisedCallback(callback));
const secret = "fixture-client-secret";
const configure = (
  store: ServerSecretStore["Service"],
  name: string,
  title: string,
  options: { clientId?: string; clientSecret?: string; redirectUri?: string; pin?: string } = {},
) =>
  manageLocalVault(store, {
    action: "gmail-configure",
    name,
    title,
    clientId: options.clientId ?? grant.clientId,
    redirectUri: options.redirectUri ?? callback,
    pin: Redacted.make(options.pin ?? PIN),
    ...(options.clientSecret === undefined
      ? {}
      : { clientSecret: Redacted.make(options.clientSecret) }),
  });
const enroll = Effect.fn("test.enrollMailClient")(function* (
  store: ServerSecretStore["Service"],
  name: string,
  title: string,
) {
  assert.isNull((yield* configure(store, name, title, { clientSecret: secret })).error);
  const client = (yield* readVaultRecord(store, name))?.gmailClient;
  if (!client) throw new Error("Client registration was not stored.");
  return { name, title, grant, expectedClientRevision: client.revision };
});

it.effect(
  "encrypts the Web client and grant, lists public metadata, and disconnects just the mailbox",
  () =>
    Effect.gen(function* () {
      const { store, fs } = yield* makeStore();
      const connect = yield* enroll(store, "work-mail", "Work mail");
      const before = (yield* vaultSecuritySummary(store)).epoch;
      for (const [target, code] of [
        [{ ...store, storageMode: "private-files" }, PIN],
        [store, "000000"],
      ] as const) {
        const pin = Redacted.make(code);
        yield* Effect.flip(setVaultGmailGrant(target, { ...connect, pin }));
        assert.throws(() => Redacted.value(pin));
        assert.isUndefined((yield* readVaultRecord(store, connect.name))?.gmailGrant);
      }
      yield* setVaultGmailGrant(store, { ...connect, pin: Redacted.make(PIN) });
      assert.notEqual((yield* vaultSecuritySummary(store)).epoch, before);
      const bytes = yield* fs.readFile(`${store.directory}/vault-entry-work-mail.bin`);
      assert.isTrue(isVaultCiphertext(bytes));
      assert.notInclude(new TextDecoder().decode(bytes), grant.refreshToken);
      assert.notInclude(new TextDecoder().decode(bytes), secret);
      const record = yield* readVaultRecord(store, connect.name);
      assert.deepEqual(record?.gmailGrant, grant);
      for (const field of ["token", "username", "password", "note"] as const)
        assert.isUndefined(vaultField(record!, field));
      assert.isUndefined(parseLocalVaultReference("hyakki-vault://work-mail/gmailGrant"));
      const listed = yield* manageLocalVault(store, { action: "list" });
      assert.isTrue(listed.gmailAvailable);
      assert.isTrue(listed.gmailUserCredentials);
      assert.deepEqual(listed.entries, [
        {
          name: connect.name,
          title: connect.title,
          kind: "gmail",
          gmailAccount: grant.account,
          gmailClient: { clientId: grant.clientId, redirectUri: callback },
          fields: [],
          access: "ask",
        },
      ]);
      assert.notInclude(JSON.stringify(listed), secret);
      assert.notInclude(JSON.stringify(listed), connect.expectedClientRevision);
      assert.notInclude(JSON.stringify(listed), grant.refreshToken);
      const detached = { name: connect.name, pin: Redacted.make(PIN) };
      const connectedEpoch = (yield* vaultSecuritySummary(store)).epoch;
      yield* disconnectVaultGmail(store, detached);
      assert.notEqual((yield* vaultSecuritySummary(store)).epoch, connectedEpoch);
      const disconnected = yield* readVaultRecord(store, connect.name);
      assert.isUndefined(disconnected?.gmailGrant);
      assert.equal(disconnected?.gmailClient?.clientSecret, secret);
      assert.notEqual(disconnected?.gmailClient?.revision, connect.expectedClientRevision);
      yield* Effect.flip(setVaultGmailGrant(store, { ...connect, pin: Redacted.make(PIN) }));
      assert.isTrue(yield* fs.exists(`${store.directory}/vault-entry-work-mail.bin`));
    }).pipe(Effect.scoped, Effect.provide(gmailVaultLayer)),
);

it.effect("merges Gmail grants without overwriting login credentials or access rules", () =>
  Effect.gen(function* () {
    const { store } = yield* makeStore();
    assert.isNull((yield* save(store, "login", login)).error);
    const connect = yield* enroll(store, "login", login.title);
    yield* Effect.flip(
      setVaultGmailGrant(store, {
        ...connect,
        title: "Different",
        pin: Redacted.make(PIN),
      }),
    );
    yield* Effect.flip(
      setVaultGmailGrant(store, {
        ...connect,
        name: "another",
        title: ` ${login.title} `,
        pin: Redacted.make(PIN),
      }),
    );
    assert.isUndefined(yield* readVaultRecord(store, "another"));
    yield* setVaultGmailGrant(store, { ...connect, pin: Redacted.make(PIN) });
    assert.deepEqual((yield* vaultSecuritySummary(store)).rules, { login: "allow" });
    assert.isNotNull((yield* save(store, "another", { ...note, title: login.title })).error);
    assert.isNull(
      (yield* save(store, "login", { ...login, title: "Renamed", password: "" }, true)).error,
    );
    assert.deepEqual((yield* readVaultRecord(store, "login"))?.gmailGrant, grant);
    const newGrant = { ...grant, refreshToken: "replacement-private-grant" };
    yield* setVaultGmailGrant(store, {
      ...connect,
      title: "Renamed",
      grant: newGrant,
      pin: Redacted.make(PIN),
    });
    const listed = yield* manageLocalVault(store, { action: "list" });
    assert.deepEqual(listed.entries?.[0]?.fields, ["username", "password"]);
    assert.equal(listed.entries?.[0]?.gmailAccount, grant.account);
    yield* Effect.flip(
      disconnectVaultGmail(store, { name: "login", pin: Redacted.make("000000") }),
    );
    assert.deepEqual((yield* readVaultRecord(store, "login"))?.gmailGrant, newGrant);
    yield* disconnectVaultGmail(store, { name: "login", pin: Redacted.make(PIN) });
    assert.deepInclude(yield* readVaultRecord(store, "login"), {
      ...login,
      title: "Renamed",
      origin: "https://github.com",
    });
    assert.isUndefined((yield* readVaultRecord(store, "login"))?.gmailGrant);
    assert.equal((yield* readVaultRecord(store, "login"))?.gmailClient?.clientSecret, secret);
    assert.deepEqual((yield* vaultSecuritySummary(store)).rules, { login: "allow" });
  }).pipe(Effect.scoped, Effect.provide(gmailVaultLayer)),
);

it.effect(
  "refuses generic grant injection, Gmail-specific management actions, and destructive replacements",
  () =>
    Effect.gen(function* () {
      const { store } = yield* makeStore();
      const base = { version: 1 as const, kind: "gmail" as const, title: "Mail" };
      const forged = { ...token, gmailGrant: grant };
      for (const record of [
        base,
        forged,
        { ...token, gmailClient: { clientSecret: secret } },
        { ...token, gmailGrantRevision: "forged" },
      ])
        assert.isNotNull((yield* save(store, "mail", record)).error);
      assert.isUndefined(yield* readVaultRecord(store, "mail"));
      yield* setVaultGmailGrant(store, {
        ...(yield* enroll(store, "mail", "Mail")),
        pin: Redacted.make(PIN),
      });
      for (const input of [
        { action: "gmail-start", name: "mail", title: "Mail" },
        { action: "gmail-finish", name: "mail", flowId: "test-flow", pin: Redacted.make(PIN) },
        { action: "gmail-disconnect", name: "mail", pin: Redacted.make(PIN) },
        {
          action: "save",
          name: "mail",
          replace: true,
          value: Redacted.make("raw"),
          pin: Redacted.make(PIN),
        },
      ] as const) {
        assert.isNotNull((yield* manageLocalVault(store, input)).error);
        const pin = "pin" in input ? input.pin : undefined;
        if (pin) assert.throws(() => Redacted.value(pin));
      }
      assert.isNotNull((yield* save(store, "mail", base, true)).error);
      assert.deepEqual((yield* readVaultRecord(store, "mail"))?.gmailGrant, grant);
      assert.isUndefined(
        yield* readLocalVaultToken(store, {
          provider: SecretProviderId.make("hyakki-vault"),
          reference: localVaultReference("mail", "token"),
        }),
      );
      yield* store.create(
        "vault-entry-unknown-version",
        new TextEncoder().encode(JSON.stringify({ ...base, version: 2, gmailGrant: grant })),
      );
      assert.isUndefined(yield* readVaultRecord(store, "unknown-version"));
      yield* store.remove("vault-entry-unknown-version");
      const concurrent = yield* Effect.forEach(
        ["personal", "other"],
        (name) =>
          configure(store, name, "Personal Gmail", { clientSecret: secret }).pipe(
            Effect.map((result) => result.error === null),
          ),
        { concurrency: "unbounded" },
      );
      assert.lengthOf(concurrent.filter(Boolean), 1);
      assert.isNull((yield* save(store, "service", token)).error);
      yield* setVaultGmailGrant(store, {
        ...(yield* enroll(store, "service", token.title)),
        pin: Redacted.make(PIN),
      });
      assert.isNotNull((yield* save(store, "service", forged, true)).error);
      assert.isNull(
        (yield* manageLocalVault(store, {
          action: "save",
          name: "service",
          replace: true,
          value: Redacted.make("new-token"),
          pin: Redacted.make(PIN),
        })).error,
      );
      assert.deepInclude(yield* readVaultRecord(store, "service"), {
        token: "new-token",
        gmailGrant: grant,
      });
    }).pipe(Effect.scoped, Effect.provide(gmailVaultLayer)),
);

it.effect(
  "suggests the native server callback without credentials and rejects a renderer port",
  () =>
    Effect.gen(function* () {
      const { store } = yield* makeStore();
      const listed = yield* manageLocalVault(store, { action: "list" });
      assert.isTrue(listed.gmailUserCredentials);
      assert.equal(listed.gmailRedirectUri, "http://127.0.0.1:19341/oauth/gmail/callback");
      assert.isNotNull(
        (yield* configure(store, "native", "Native", {
          clientSecret: secret,
          redirectUri: "http://127.0.0.1:5733/oauth/gmail/callback",
        })).error,
      );
      assert.isNull(
        (yield* configure(store, "native", "Native", {
          clientSecret: secret,
          redirectUri: listed.gmailRedirectUri!,
        })).error,
      );
      assert.equal(
        (yield* readVaultRecord(store, "native"))?.gmailClient?.redirectUri,
        listed.gmailRedirectUri,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provideService(ServerConfig, { port: 19341 } as ServerConfig["Service"]),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    ),
);

it.effect(
  "keeps same-client secret on omission, revokes grants on rotation, and rejects stale writes",
  () =>
    Effect.gen(function* () {
      const { store } = yield* makeStore();
      const name = "mail",
        title = "Mail";
      const otherId = "98765-personal.apps.googleusercontent.com";
      for (const invalid of [
        {},
        { clientSecret: " " },
        { clientId: "not-google", clientSecret: secret },
        { redirectUri: "https://other.example.test/oauth/gmail/callback", clientSecret: secret },
        { redirectUri: "http://vault.example.test/oauth/gmail/callback", clientSecret: secret },
        {
          redirectUri: "https://vault.example.test/oauth/gmail/callback?x=1",
          clientSecret: secret,
        },
        { clientSecret: secret, pin: "000000" },
      ]) {
        assert.isNotNull((yield* configure(store, name, title, invalid)).error);
        assert.isUndefined(yield* readVaultRecord(store, name));
      }
      const unavailable = yield* configure(store, name, title, { clientSecret: secret }).pipe(
        Effect.provide(advertisedCallback()),
      );
      assert.isNotNull(unavailable.error);
      assert.isUndefined(yield* readVaultRecord(store, name));
      const start = yield* enroll(store, name, title);
      const finish = () => setVaultGmailGrant(store, { ...start, pin: Redacted.make(PIN) });
      yield* finish();
      const before = (yield* vaultSecuritySummary(store)).epoch;
      assert.isNull((yield* configure(store, name, title)).error);
      assert.equal((yield* vaultSecuritySummary(store)).epoch, before);
      assert.isNotNull((yield* configure(store, name, title, { clientId: otherId })).error);
      assert.isNotNull(
        (yield* configure(store, name, "Collision", { clientSecret: secret })).error,
      );
      assert.deepEqual((yield* readVaultRecord(store, name))?.gmailGrant, grant);
      assert.isTrue(
        yield* Effect.isFailure(
          setVaultGmailGrant(store, {
            ...start,
            grant: { ...grant, clientId: otherId },
            pin: Redacted.make(PIN),
          }),
        ),
      );
      const [, rotated] = yield* Effect.all(
        [
          Effect.exit(finish()),
          configure(store, name, title, {
            clientSecret: "rotated-test-secret",
          }),
        ],
        { concurrency: 2 },
      );
      assert.isNull(rotated.error);
      assert.notEqual((yield* vaultSecuritySummary(store)).epoch, before);
      assert.isUndefined((yield* readVaultRecord(store, name))?.gmailGrant);
      assert.isTrue(yield* Effect.isFailure(finish()));
      const current = (yield* readVaultRecord(store, name))!.gmailClient!;
      assert.notEqual(current.revision, start.expectedClientRevision);
      const nextCallback = "https://new.example.test/oauth/gmail/callback";
      const updated = yield* configure(store, name, title, { redirectUri: nextCallback }).pipe(
        Effect.provide(advertisedCallback(nextCallback)),
      );
      assert.isNull(updated.error);
      const redirected = (yield* readVaultRecord(store, name))!.gmailClient!;
      assert.equal(redirected.clientSecret, current.clientSecret);
      assert.notEqual(redirected.revision, current.revision);
    }).pipe(Effect.scoped, Effect.provide(gmailVaultLayer)),
);

it.effect(
  "legacy grants are neither connected nor credentials; unreadable slots cannot be overwritten",
  () =>
    Effect.gen(function* () {
      const { store } = yield* makeStore();
      const old = { version: 1, kind: "gmail", title: "Legacy", gmailGrant: grant };
      yield* store.create("vault-entry-legacy", new TextEncoder().encode(JSON.stringify(old)));
      const entry = (yield* manageLocalVault(store, { action: "list" })).entries?.[0];
      assert.deepEqual(entry, {
        name: "legacy",
        title: "Legacy",
        kind: "gmail",
        fields: [],
        access: "ask",
      });
      const start = yield* enroll(store, "legacy", "Legacy");
      assert.isUndefined((yield* readVaultRecord(store, "legacy"))?.gmailGrant);
      yield* setVaultGmailGrant(store, { ...start, pin: Redacted.make(PIN) });
      const opaque = new TextEncoder().encode(JSON.stringify({ ...old, version: 7 }));
      yield* store.create("vault-entry-unknown", opaque);
      assert.isNotNull(
        (yield* configure(store, "unknown", "Recovered", { clientSecret: secret })).error,
      );
      assert.isUndefined(yield* readVaultRecord(store, "unknown"));
      assert.deepEqual(Option.getOrThrow(yield* store.get("vault-entry-unknown")), opaque);
      yield* store.create(
        "vault-entry-truncated",
        new TextEncoder().encode('{"gmailClient":{"clientSecret":'),
      );
      assert.isUndefined(yield* readVaultRecord(store, "truncated"));
      const pin = Redacted.make(PIN),
        clientSecret = Redacted.make(secret);
      const unavailable = yield* manageLocalVault(undefined, {
        action: "gmail-configure",
        name: "mail",
        title: "Mail",
        clientId: grant.clientId,
        redirectUri: callback,
        pin,
        clientSecret,
      });
      assert.isNotNull(unavailable.error);
      for (const handle of [pin, clientSecret]) assert.throws(() => Redacted.value(handle));
    }).pipe(Effect.scoped, Effect.provide(gmailVaultLayer)),
);

const connect = (
  store: ServerSecretStore["Service"] | undefined,
  name: string,
  title: string,
  service: VaultTokenService,
  token: string,
  pin = PIN,
) =>
  manageLocalVault(store, {
    action: "connect-service",
    name,
    title,
    service,
    token: Redacted.make(token),
    pin: Redacted.make(pin),
  });

it.effect(
  "connects only fieldless encrypted service entries; never exposes the token or binds them to Gmail",
  () =>
    Effect.gen(function* () {
      const { store, fs } = yield* makeStore();
      const token = "fixture-protected-service-token";
      const readIdentity = Effect.provideService(FetchHttpClient.Fetch, async (url, init) => {
        const req = new Request(url, init);
        assert.equal(req.url, "https://api.github.com/user");
        assert.equal(req.headers.get("authorization"), `Bearer ${token}`);
        return Response.json({ login: "fixture-member", email: "never-publish@example.test" });
      });
      const result = yield* connect(store, "repos", "Work repos", "github", token).pipe(
        readIdentity,
      );
      assert.isNull(result.error);
      assert.deepEqual(result.credentialServices, [
        "gmail",
        "github",
        "gitlab",
        "slack",
        "airtable",
        "asana",
        "linear",
        "netlify",
        "notion",
        "todoist",
        "typeform",
        "vercel",
      ]);
      const revision = result.entries?.[0]?.serviceConnection?.revision;
      if (revision === undefined) throw new Error("Missing service connection revision");
      assert.deepEqual(result.entries, [
        {
          kind: "service",
          name: "repos",
          title: "Work repos",
          access: "ask",
          fields: [],
          serviceConnection: { service: "github", account: "fixture-member", revision },
        },
      ]);
      assert.notInclude(JSON.stringify(result), token);
      const ciphertext = yield* fs.readFile(`${store.directory}/vault-entry-repos.bin`);
      assert.isTrue(isVaultCiphertext(ciphertext));
      assert.notInclude(new TextDecoder().decode(ciphertext), token);
      const record = yield* readVaultRecord(store, "repos");
      assert.isDefined(record);
      for (const field of ["token", "username", "password", "note"] as const)
        assert.isUndefined(vaultField(record!, field));
      assert.equal(record?.serviceConnection?.revision, revision);
      assert.isNull(
        (yield* connect(store, "repos", "Team repos", "github", token).pipe(readIdentity)).error,
      );
      const current = yield* readVaultRecord(store, "repos");
      assert.equal(current?.title, "Team repos");
      assert.notEqual(current?.serviceConnection?.revision, revision);
      assert.isUndefined(
        yield* readLocalVaultToken(store, {
          provider: SecretProviderId.make("hyakki-vault"),
          reference: localVaultReference("repos", "token"),
        }),
      );
      assert.isNotNull(
        (yield* configure(store, "repos", "Work repos", { clientSecret: secret })).error,
      );
      const base = { version: 1 as const, kind: "service" as const, title: "Work repos" };
      for (const forged of [
        base,
        { ...base, serviceConnection: current!.serviceConnection },
        { ...login, serviceConnection: current!.serviceConnection },
      ])
        assert.isNotNull((yield* save(store, "repos", forged, true)).error);
      assert.isNotNull(
        (yield* manageLocalVault(store, {
          action: "save",
          name: "repos",
          value: Redacted.make(token),
          pin: Redacted.make(PIN),
          replace: true,
        })).error,
      );
      assert.deepEqual(yield* readVaultRecord(store, "repos"), current);
      assert.isNull((yield* save(store, "login", login)).error);
      assert.isNotNull(
        (yield* manageLocalVault(store, {
          action: "remove",
          name: "repos",
          pin: Redacted.make("000000"),
        })).error,
      );
      assert.isNull(
        (yield* manageLocalVault(store, {
          action: "remove",
          name: "repos",
          pin: Redacted.make(PIN),
        })).error,
      );
      assert.isUndefined(yield* readVaultRecord(store, "repos"));
      assert.equal((yield* readVaultRecord(store, "login"))?.kind, "login");
    }).pipe(Effect.scoped, Effect.provide(gmailVaultLayer)),
);

it.effect(
  "requires valid vault PIN, available encrypted storage and an unambiguous free slot before sending tokens",
  () =>
    Effect.gen(function* () {
      const { store } = yield* makeStore();
      const token = "fixture-verify-before-save";
      let requests = 0;
      const reject = Effect.provideService(FetchHttpClient.Fetch, async () => {
        requests++;
        return new Response(token, { status: 401 });
      });
      assert.isNull((yield* save(store, "existing", login)).error);
      for (const attempt of [
        connect(undefined, "slot", "Service", "github", token),
        connect({ ...store, storageMode: "private-files" }, "slot", "Service", "github", token),
        connect(store, "slot", "Service", "github", token, "000000"),
        connect(store, "slot", login.title, "github", token),
        connect(store, "existing", login.title, "github", token),
      ])
        assert.isNotNull((yield* attempt.pipe(reject)).error);
      assert.equal(requests, 0);
      const pin = Redacted.make(PIN),
        value = Redacted.make(token);
      const denied = yield* manageLocalVault(store, {
        action: "connect-service",
        name: "slot",
        title: "Service",
        service: "github",
        token: value,
        pin,
      }).pipe(reject);
      assert.isNotNull(denied.error);
      assert.notInclude(JSON.stringify(denied), token);
      for (const handle of [pin, value]) assert.throws(() => Redacted.value(handle));
      assert.equal(requests, 1);
      assert.isUndefined(yield* readVaultRecord(store, "slot"));
      assert.deepInclude(yield* readVaultRecord(store, "existing"), { password: login.password });
      assert.isNull(
        (yield* connect(store, "slot", "Service", "github", token).pipe(
          Effect.provideService(FetchHttpClient.Fetch, async () =>
            Response.json({ login: "fixture-member" }),
          ),
        )).error,
      );
      const previous = yield* readVaultRecord(store, "slot");
      assert.isNotNull(
        (yield* connect(store, "slot", "Service", "gitlab", token).pipe(reject)).error,
      );
      assert.equal(requests, 1);
      assert.isNotNull(
        (yield* connect(store, "slot", "Service", "github", "replacement").pipe(reject)).error,
      );
      assert.deepEqual(yield* readVaultRecord(store, "slot"), previous);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "does not lock the vault during verification or resurrect a credential deleted before it completes",
  () =>
    Effect.gen(function* () {
      const { store } = yield* makeStore();
      const token = "fixture-private-token";
      const start = () => connect(store, "group", "Team", "gitlab", token);
      const identity = { username: "fixture-reader" };
      assert.isNull(
        (yield* start().pipe(
          Effect.provideService(FetchHttpClient.Fetch, async () => Response.json(identity)),
        )).error,
      );
      const started = Promise.withResolvers<void>(),
        reply = Promise.withResolvers<Response>();
      const inflight = yield* start().pipe(
        Effect.provideService(FetchHttpClient.Fetch, () => {
          started.resolve();
          return reply.promise;
        }),
        Effect.forkChild,
      );
      yield* Effect.promise(() => started.promise);
      assert.isNull(
        (yield* manageLocalVault(store, {
          action: "remove",
          name: "group",
          pin: Redacted.make(PIN),
        })).error,
      );
      reply.resolve(Response.json(identity));
      assert.isNotNull((yield* Fiber.join(inflight)).error);
      assert.isUndefined(yield* readVaultRecord(store, "group"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "never interprets malformed or unsupported service connections as legacy API tokens",
  () =>
    Effect.gen(function* () {
      const { store } = yield* makeStore();
      for (const raw of [
        '{"kind":"service","token":"private",',
        '{"serviceConnection":{"token":"private"',
        JSON.stringify({ version: 2, kind: "service", title: "Corrupt", serviceConnection: {} }),
        JSON.stringify({ ...token, serviceConnection: {} }),
        JSON.stringify({
          version: 1,
          kind: "service",
          title: "Corrupt",
          serviceConnection: { service: "unknown" },
        }),
      ]) {
        yield* store.set("vault-entry-bad", new TextEncoder().encode(raw));
        assert.isUndefined(yield* readVaultRecord(store, "bad"));
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const isInput = Schema.is(LocalVaultInput);
it("requires settings permission, rejects traversal, and binds logins to exact HTTPS origins", () => {
  assert.deepStrictEqual(clientRpcRequiredScopes(WS_METHODS.serverManageLocalVault, {}), [
    AuthSettingsWriteScope,
    AuthProvidersManageScope,
  ]);
  assert.equal(requiredScopeForRpcMethod(WS_METHODS.serverListLocalVault), AuthSettingsWriteScope);
  assert.isFalse(isInput({ action: "remove", name: "../internal-key" }));
  const normalized = { ...login, origin: "https://github.com" };
  assert.isTrue(vaultOriginMatches(normalized, "https://github.com/login"));
  for (const target of [
    undefined,
    "https://evil.github.com",
    "http://github.com",
    "https://github.com.evil.test",
    "https://github.com:444",
    "https://user@github.com",
  ])
    assert.isFalse(vaultOriginMatches(normalized, target));
});
