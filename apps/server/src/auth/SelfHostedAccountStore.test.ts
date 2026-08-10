import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthReviewWriteScope,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { scryptSync } from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as SelfHostedAccountStore from "./SelfHostedAccountStore.ts";

const accountPath = "self-hosted-accounts.json";
const salt = Buffer.from("0123456789abcdef", "utf8");
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function passwordHash(password: string): string {
  const derivedKey = scryptSync(password, salt, 32, { N: 16_384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${derivedKey.toString("base64url")}`;
}

const makeConfigLayer = (accountsFile: string | undefined) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.map(ServerConfig.ServerConfig, (config) => ({
      ...config,
      selfHostedAccountsFile: accountsFile,
    })),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-selfhost-test-" })));

const makeStoreLayer = (accountsFile: string | undefined, contents?: string) =>
  SelfHostedAccountStore.layer.pipe(
    Layer.provide(makeConfigLayer(accountsFile)),
    Layer.provideMerge(
      Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (fileSystem) => ({
          ...fileSystem,
          readFileString: (path, encoding) =>
            String(path) === accountPath
              ? contents === undefined
                ? Effect.die("unexpected account file read")
                : Effect.succeed(contents)
              : fileSystem.readFileString(path, encoding),
        })),
      ).pipe(Layer.provide(NodeServices.layer)),
    ),
  );

it.layer(NodeServices.layer)("SelfHostedAccountStore", (it) => {
  it.effect("stays disabled and rejects credentials when no account file is configured", () =>
    Effect.gen(function* () {
      const store = yield* SelfHostedAccountStore.SelfHostedAccountStore;

      assert.isFalse(store.enabled);
      assert.isTrue(Option.isNone(yield* store.authenticate("demo", "password")));
    }).pipe(Effect.provide(makeStoreLayer(undefined))),
  );

  it.effect("authenticates configured accounts with default minimum scopes", () =>
    Effect.gen(function* () {
      const store = yield* SelfHostedAccountStore.SelfHostedAccountStore;
      const account = yield* store.authenticate(" demo ", "correct horse");

      assert.isTrue(store.enabled);
      assert.isTrue(Option.isSome(account));
      if (Option.isSome(account)) {
        assert.strictEqual(account.value.username, "demo");
        assert.deepEqual(account.value.scopes, [
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
        ]);
        assert.strictEqual(account.value.label, "Demo phone");
      }
      assert.isTrue(Option.isNone(yield* store.authenticate("demo", "wrong")));
      assert.isTrue(Option.isNone(yield* store.authenticate("missing", "correct horse")));
    }).pipe(
      Effect.provide(
        makeStoreLayer(
          accountPath,
          encodeJson({
            version: 1,
            accounts: [
              {
                username: "demo",
                passwordHash: passwordHash("correct horse"),
                label: "Demo phone",
              },
            ],
          }),
        ),
      ),
    ),
  );

  it.effect("preserves explicitly configured scopes", () =>
    Effect.gen(function* () {
      const store = yield* SelfHostedAccountStore.SelfHostedAccountStore;
      const account = yield* store.authenticate("reviewer", "secret");

      assert.deepEqual(Option.getOrThrow(account).scopes, [AuthReviewWriteScope]);
    }).pipe(
      Effect.provide(
        makeStoreLayer(
          accountPath,
          encodeJson({
            version: 1,
            accounts: [
              {
                username: "reviewer",
                passwordHash: passwordHash("secret"),
                scopes: [AuthReviewWriteScope],
              },
            ],
          }),
        ),
      ),
    ),
  );

  it.effect("fails closed for duplicate users and invalid password hashes", () =>
    Effect.gen(function* () {
      const duplicate = encodeJson({
        version: 1,
        accounts: [
          { username: "demo", passwordHash: passwordHash("one") },
          { username: "demo", passwordHash: passwordHash("two") },
        ],
      });
      const invalidHash = encodeJson({
        version: 1,
        accounts: [{ username: "demo", passwordHash: "plaintext" }],
      });

      for (const contents of [duplicate, invalidHash]) {
        const exit = yield* Effect.exit(
          Effect.service(SelfHostedAccountStore.SelfHostedAccountStore).pipe(
            Effect.provide(makeStoreLayer(accountPath, contents)),
          ),
        );
        assert.strictEqual(exit._tag, "Failure");
      }
    }),
  );
});
