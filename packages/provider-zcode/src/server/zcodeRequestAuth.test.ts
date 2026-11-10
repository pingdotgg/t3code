// @effect-diagnostics nodeBuiltinImport:off -- tests craft the CLI's own AES-GCM store values with node crypto
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  decryptZcodeCredential,
  makeZcodeRequestAuth,
  resolveZcodeCredentialSecret,
  zcodeAccountScope,
  zcodeFamilyFromProviderId,
} from "./zcodeRequestAuth.ts";
import { zcodeRecordField, zcodeRecordString } from "./zcodeProtocol.ts";

/** Produces store values the CLI's fallback cipher would hold, keyed the same way. */
const encryptZcodeCredential = (value: string, secret: string): string => {
  const iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv(
    "aes-256-gcm",
    NodeCrypto.createHash("sha256").update(secret).digest(),
    iv,
  );
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
};

describe("resolveZcodeCredentialSecret", () => {
  it("prefers ZCODE_CREDENTIAL_SECRET and trims it", () => {
    assert.equal(
      resolveZcodeCredentialSecret({ ZCODE_CREDENTIAL_SECRET: " custom-secret " }, "linux"),
      "custom-secret",
    );
    const blankOverride = resolveZcodeCredentialSecret(
      { ZCODE_CREDENTIAL_SECRET: "   ", HOME: "/home/dev" },
      "linux",
    );
    assert.match(blankOverride, /^zcode-credential-fallback:linux:\/home\/dev:/);
  });

  it("derives the CLI's machine-bound fallback with the HOME from the environment", () => {
    // Username comes from os.userInfo() where resolvable (env names never win); on runtimes
    // where it throws, the env fallback speaks. Only the stable parts are asserted here.
    const secret = resolveZcodeCredentialSecret(
      { USER: "someoneElse", HOME: "/home/dev" },
      "darwin",
    );
    assert.match(secret, /^zcode-credential-fallback:darwin:\/home\/dev:/);
    assert.match(resolveZcodeCredentialSecret({}, "linux"), /^zcode-credential-fallback:linux:/);
  });
});

describe("decryptZcodeCredential", () => {
  it("round-trips the CLI's encrypted store values", () => {
    const secret = "zcode-credential-fallback:linux:/home/dev:jame";
    for (const plaintext of ["oauth-login-token", "值-with-unicode 🔐", ""]) {
      assert.equal(
        decryptZcodeCredential(encryptZcodeCredential(plaintext, secret), secret),
        plaintext,
      );
    }
  });

  it("passes plain store values through and rejects malformed ciphertext", () => {
    assert.equal(decryptZcodeCredential("plain-token", "s"), "plain-token");
    assert.throws(() => decryptZcodeCredential("enc:v1:not-a-cipher", "s"));
    assert.throws(() => decryptZcodeCredential("enc:v1:only.two", "s"));
  });
});

describe("zcodeFamilyFromProviderId", () => {
  it("maps account plan provider ids to their auth family", () => {
    assert.equal(zcodeFamilyFromProviderId("account:zai-individual-coding-plan"), "zai");
    assert.equal(zcodeFamilyFromProviderId("account:bigmodel-individual-coding-plan"), "bigmodel");
    assert.equal(zcodeFamilyFromProviderId("account:zai"), "zai");
  });

  it("returns undefined for provider ids outside the account namespace", () => {
    assert.equal(zcodeFamilyFromProviderId(undefined), undefined);
    assert.equal(zcodeFamilyFromProviderId("account:"), undefined);
    assert.equal(zcodeFamilyFromProviderId(""), undefined);
  });
});

describe("zcodeAccountScope", () => {
  it("digests the plan identity, login token, and JWT exactly like the CLI", () => {
    assert.equal(
      zcodeAccountScope("zai", "login-token", undefined),
      NodeCrypto.createHash("sha256")
        .update(JSON.stringify(["zai", "individual-coding-plan", null, "login-token", null]))
        .digest("hex"),
    );
    assert.equal(
      zcodeAccountScope("zai", "login-token", "jwt"),
      NodeCrypto.createHash("sha256")
        .update(JSON.stringify(["zai", "individual-coding-plan", null, "login-token", "jwt"]))
        .digest("hex"),
    );
  });

  it("is deterministic and changes with any input", () => {
    assert.equal(
      zcodeAccountScope("zai", "tok", undefined),
      zcodeAccountScope("zai", "tok", undefined),
    );
    assert.notEqual(
      zcodeAccountScope("zai", "tok", undefined),
      zcodeAccountScope("bigmodel", "tok", undefined),
    );
    assert.notEqual(
      zcodeAccountScope("zai", "tok", undefined),
      zcodeAccountScope("zai", "tok2", undefined),
    );
  });
});

describe("makeZcodeRequestAuth", () => {
  /** A temp data root with the zai login on disk plus an HTTP fake answering the mint chain. */
  const harness = Effect.fnUntraced(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "zcode-request-auth-test-" });
    yield* fileSystem.makeDirectory(`${root}/.zcode/v2`, { recursive: true });
    const platform = yield* HostProcess.Platform;
    const environment = { ZCODE_DATA_BASE_DIR: root, HOME: "/home/dev", USER: "dev" };
    const secret = resolveZcodeCredentialSecret(environment, platform);
    const writeLogin = (loginToken: string | undefined) =>
      fileSystem.writeFileString(
        `${root}/.zcode/v2/credentials.json`,
        JSON.stringify(
          loginToken === undefined
            ? {}
            : { "oauth:zai:access_token": encryptZcodeCredential(loginToken, secret) },
        ),
      );
    yield* writeLogin("login-a");
    const exchangeLogins: Array<string> = [];
    const httpClient = HttpClient.make((request, url) => {
      const ok = (data: unknown) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ code: 200, data })));
      if (url.pathname.endsWith("/api/biz/customer/getCustomerInfo")) {
        return ok({
          organizations: [
            {
              organizationId: "org-1",
              organizationName: "默认机构",
              projects: [{ projectId: "proj-1", projectName: "默认项目" }],
            },
          ],
        });
      }
      if (url.pathname.endsWith("/api_keys")) {
        return ok([{ name: "zcode-api-key", apiKey: "key-1" }]);
      }
      exchangeLogins.push((request.headers.authorization ?? "").replace(/^Bearer /, ""));
      return ok({ accessToken: `access-token-${exchangeLogins.length}` });
    });
    return {
      auth: makeZcodeRequestAuth({ fileSystem, httpClient, environment, clientVersion: "test" }),
      writeLogin,
      exchangeLogins,
    };
  });

  const requestAuthOf = (response: unknown): Record<string, unknown> =>
    (zcodeRecordField(response, "requestAuth") ?? {}) as Record<string, unknown>;

  it.effect("serves a cache hit while the family's credentials stay the same", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const first = yield* h.auth.answerRuntimeHeaders({ family: "zai" });
      assert.equal(zcodeRecordString(requestAuthOf(first), "apiKey"), "access-token-1");
      assert.equal(
        zcodeRecordString(requestAuthOf(first), "accountScope"),
        zcodeAccountScope("zai", "login-a", undefined),
      );
      // The CLI may rewrite the store with a fresh IV for the same token; the credential scope,
      // not the ciphertext, must decide validity.
      yield* h.writeLogin("login-a");
      const second = yield* h.auth.answerRuntimeHeaders({ family: "zai" });
      assert.equal(zcodeRecordString(requestAuthOf(second), "apiKey"), "access-token-1");
      assert.deepEqual(h.exchangeLogins, ["login-a"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("re-mints against the new account when the family's login changes", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const first = yield* h.auth.answerRuntimeHeaders({ family: "zai" });
      assert.equal(zcodeRecordString(requestAuthOf(first), "apiKey"), "access-token-1");
      yield* h.writeLogin("login-b");
      const second = yield* h.auth.answerRuntimeHeaders({ family: "zai" });
      assert.equal(zcodeRecordString(requestAuthOf(second), "apiKey"), "access-token-2");
      assert.equal(
        zcodeRecordString(requestAuthOf(second), "accountScope"),
        zcodeAccountScope("zai", "login-b", undefined),
      );
      assert.equal(zcodeRecordString(requestAuthOf(second), "apiKeyId"), "key-1");
      assert.deepEqual(h.exchangeLogins, ["login-a", "login-b"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("declines once the family's login disappears", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const first = yield* h.auth.answerRuntimeHeaders({ family: "zai" });
      assert.equal(zcodeRecordString(requestAuthOf(first), "apiKey"), "access-token-1");
      yield* h.writeLogin(undefined);
      const second = yield* h.auth.answerRuntimeHeaders({ family: "zai" });
      assert.equal(zcodeRecordField(second, "headersApplied"), false);
      assert.match(zcodeRecordString(second, "errorMessage") ?? "", /no OAuth login for family/);
      assert.deepEqual(h.exchangeLogins, ["login-a"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
