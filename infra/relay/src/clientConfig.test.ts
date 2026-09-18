import { inMemoryState } from "alchemy/State";
import * as Test from "alchemy/Test/Vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { PublishClientConfig, reconcileEnvFile, tokenDigest } from "./clientConfig.ts";

describe("reconcileEnvFile", () => {
  it("adds every entry to an empty file", () => {
    expect(reconcileEnvFile("", { A: "1", B: "2" })).toBe("A=1\nB=2\n");
  });

  it("replaces stale values and keeps unrelated lines", () => {
    const existing = "KEEP=yes\nA=old\n# comment\n";
    expect(reconcileEnvFile(existing, { A: "new", B: "2" })).toBe(
      "KEEP=yes\nA=new\n# comment\nB=2\n",
    );
  });

  it("appends a newline before adding to a file without one", () => {
    expect(reconcileEnvFile("A=1", { B: "2" })).toBe("A=1\nB=2\n");
  });
});

const { test } = Test.make({
  providers: Layer.empty,
  state: inMemoryState(),
});

const clientConfig = (token: string) => ({
  url: "https://relay.example.com",
  mobileTracingUrl: "https://axiom.example.com/v1/traces",
  mobileTracingDataset: "relay-traces",
  mobileTracingToken: Redacted.make(`mobile-${token}`),
  clientTracingUrl: "https://axiom.example.com/v1/traces",
  clientTracingDataset: "relay-traces",
  clientTracingToken: Redacted.make(`client-${token}`),
  tokenDigest: tokenDigest([Redacted.make(`mobile-${token}`), Redacted.make(`client-${token}`)]),
});

describe("PublishClientConfig", () => {
  test.provider("writes the env file on deploy and skips an unchanged redeploy", (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-client-config-" });
      const target = path.join(dir, "client.env");
      yield* fs.writeFileString(target, "KEEP=yes\n");
      const configured = Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ T3CODE_RELAY_CLIENT_CONFIG_ENV: target }),
        ),
      );

      yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* PublishClientConfig(clientConfig("v1"));
          }),
        )
        .pipe(configured);
      const first = yield* fs.readFileString(target);
      expect(first).toContain("KEEP=yes\n");
      expect(first).toContain("T3CODE_RELAY_URL=https://relay.example.com\n");
      expect(first).toContain("T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN=client-v1\n");
      expect(first).toContain("T3CODE_MOBILE_OTLP_TRACES_TOKEN=mobile-v1\n");

      // Same input: the action is skipped, so a change made by hand survives.
      yield* fs.writeFileString(target, `${first}MANUAL=1\n`);
      yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* PublishClientConfig(clientConfig("v1"));
          }),
        )
        .pipe(configured);
      expect(yield* fs.readFileString(target)).toContain("MANUAL=1\n");

      // A rotated token changes the input, so it runs again and replaces the line.
      yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* PublishClientConfig(clientConfig("v2"));
          }),
        )
        .pipe(configured);
      const third = yield* fs.readFileString(target);
      expect(third).toContain("T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN=client-v2\n");
      expect(third).not.toContain("client-v1");
      expect(third).toContain("KEEP=yes\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
