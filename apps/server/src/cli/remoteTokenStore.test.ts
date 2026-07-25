// @effect-diagnostics nodeBuiltinImport:off - permission assertions exercise the Node filesystem boundary.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { loadRemoteCliToken, remoteCliTokenPath, storeRemoteCliToken } from "./remoteTokenStore.ts";

describe("remote CLI token storage", () => {
  it("rejects credentials embedded in a remote host URL", () => {
    expect(() =>
      remoteCliTokenPath("/tmp/t3-remote", "https://bootstrap-secret@example.test"),
    ).toThrow("must not contain credentials");
  });

  it.effect("stores only access token and expiry with restrictive permissions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDirectory = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-remote-cli-token-test-",
        });
        const now = yield* Clock.currentTimeMillis;
        const input = {
          stateDirectory,
          httpBaseUrl: "https://remote.example/",
          token: { accessToken: "access-secret", expiresAtEpochMs: now + 60_000 },
        };
        yield* storeRemoteCliToken(input);

        const tokenPath = remoteCliTokenPath(stateDirectory, input.httpBaseUrl);
        const stored = NodeFS.readFileSync(tokenPath, "utf8");
        expect(stored).toContain("access-secret");
        expect(stored).not.toContain("bootstrap");
        // @effect-diagnostics-next-line preferSchemaOverJson:off - verifies exact persisted keys.
        expect(Object.keys(JSON.parse(stored))).toEqual(["accessToken", "expiresAtEpochMs"]);
        expect(NodeFS.statSync(stateDirectory).mode & 0o777).toBe(0o700);
        expect(NodeFS.statSync(tokenPath).mode & 0o777).toBe(0o600);
        expect(yield* loadRemoteCliToken(input)).toEqual(input.token);

        const stableInput = {
          ...input,
          httpBaseUrl: "http://127.0.0.1:1234/",
          tokenStorageKey: "environment:stable-local",
        };
        yield* storeRemoteCliToken(stableInput);
        expect(
          yield* loadRemoteCliToken({
            ...stableInput,
            httpBaseUrl: "http://127.0.0.1:5678/",
          }),
        ).toEqual(input.token);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer))),
  );
});
