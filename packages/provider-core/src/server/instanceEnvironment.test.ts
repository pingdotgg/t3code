import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { SecretProviderId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { makeInjectedSecrets, mergeProviderInstanceEnvironment } from "./instanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it.effect.each([
    { value: "~/.account", tail: ".account" },
    { value: "~\\.account\\work", tail: ".account\\work" },
  ])("expands configured provider homes set to $value", ({ value, tail }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnv = {
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
        GROK_HOME: "~/.inherited-grok",
      };
      const environment = yield* mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "GROK_HOME", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join("/home/ada", tail),
        CLAUDE_CONFIG_DIR: path.join("/home/ada", tail),
        GROK_HOME: path.join("/home/ada", tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
        GROK_HOME: "~/.inherited-grok",
      });
    }).pipe(
      Effect.provideService(HostProcess.HomeDirectory, "/home/ada"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("leaves inherited provider homes unchanged", () =>
    Effect.gen(function* () {
      const baseEnv = { CODEX_HOME: "~/.codex", CLAUDE_CONFIG_DIR: "~\\.claude" };

      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
          baseEnv,
        ),
      ).toEqual({ ...baseEnv, CUSTOM_VALUE: "~/.custom" });
    }),
  );

  it.effect("overrides inherited environment values and preserves empty strings", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment(
          [
            { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
            { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
            {
              name: "OPENAI_API_KEY",
              value: {
                provider: SecretProviderId.make("personal"),
                reference: "op://Private/OpenAI/credential",
              },
              sensitive: true,
            },
          ],
          { ANTHROPIC_API_KEY: "inherited", OPENAI_API_KEY: "inherited", PATH: "/bin" },
        ),
      ).toMatchObject({
        OPENROUTER_API_KEY: "sk-or-test",
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "inherited",
        PATH: "/bin",
      });
    }),
  );

  it.effect("replaces every inherited spelling of a name on Windows, and only there", () =>
    Effect.gen(function* () {
      const merge = (platform: NodeJS.Platform) =>
        mergeProviderInstanceEnvironment(
          [{ name: "Https_Proxy", value: "http://gateway", sensitive: false }],
          { HTTPS_PROXY: "http://mine", PATH: "/bin" },
        ).pipe(Effect.provideService(HostProcess.Platform, platform));
      // A home variable in another spelling is still expanded.
      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "Codex_Home", value: "~/corp", sensitive: false }],
          {},
        ).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.HomeDirectory, "/home/ada"),
        ),
      ).toEqual({ CODEX_HOME: "/home/ada/corp" });
      // Upper case sorts first, so it also wins where a spawn merges the parent environment back.
      expect(yield* merge("win32")).toEqual({ HTTPS_PROXY: "http://gateway", PATH: "/bin" });
      expect(yield* merge("linux")).toEqual({
        HTTPS_PROXY: "http://mine",
        Https_Proxy: "http://gateway",
        PATH: "/bin",
      });
    }),
  );
});

describe("makeInjectedSecrets", () => {
  it("replaces every exact value once, without rescanning the markers it inserts", () => {
    const secrets = makeInjectedSecrets();
    secrets.put("instance", [
      { name: "PIN", value: "4242-4242" },
      { name: "TOKEN", value: "redacted" },
      { name: "LONG", value: "abc-redacted-xyz" },
      { name: "CLAUDE_CODE_USE_BEDROCK", value: "1" },
    ]);

    expect(secrets.redactText("exit code 1\n-  version: 1.2.1")).toBe(
      "exit code 1\n-  version: 1.2.1",
    );
    expect(secrets.redactText("pin=4242-4242 long=abc-redacted-xyz token=redacted 4 2")).toBe(
      "pin=[redacted PIN] long=[redacted LONG] token=[redacted TOKEN] 4 2",
    );
    const redacted = secrets.redact(
      JSON.parse('{"4242-4242":"redacted","__proto__":{"a":"4242-4242"},"n":7}'),
    );
    expect(JSON.stringify(redacted)).toBe(
      '{"[redacted PIN]":"[redacted TOKEN]","__proto__":{"a":"[redacted PIN]"},"n":7}',
    );
    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
  });

  it("replaces a value split across chunks and releases tails that never complete it", () => {
    const secrets = makeInjectedSecrets();
    secrets.put("instance", [{ name: "KEY", value: "s3cret-value" }]);

    const first = secrets.redactChunk("", "KEY=s3cr");
    expect(first).toEqual({ emit: "KEY=", pending: "s3cr" });
    const second = secrets.redactChunk(first.pending, "et-value\nnext s3");
    expect(second).toEqual({ emit: "[redacted KEY]\nnext ", pending: "s3" });
    expect(secrets.redactChunk(second.pending, "x")).toEqual({ emit: "s3x", pending: "" });
  });

  it("prefers the longest value whether or not it is split across chunks", () => {
    const secrets = makeInjectedSecrets();
    secrets.put("instance", [
      { name: "SHORT", value: "aaabbbccc" },
      { name: "LONG", value: "aaabbbcccdddeeefff" },
      { name: "TAIL", value: "cccdddZZZZZZ" },
    ]);

    const first = secrets.redactChunk("", "x aaabbbccc");
    expect(first).toEqual({ emit: "x ", pending: "aaabbbccc" });
    expect(secrets.redactChunk(first.pending, "dddeeefff")).toEqual({
      emit: "[redacted LONG]",
      pending: "",
    });
    expect(secrets.redactChunk(first.pending, "dddx")).toEqual({
      emit: "[redacted SHORT]dddx",
      pending: "",
    });
    // A tail held at the end of the stream can itself be a whole shorter value.
    expect(secrets.redactText(first.pending)).toBe("[redacted SHORT]");
    // The leftmost match wins even when a later value begins inside it.
    const split = secrets.redactChunk("", "aaabbbcccddd");
    expect(secrets.redactChunk(split.pending, "ZZZZZZ").emit).toBe(
      split.emit + "[redacted SHORT]dddZZZZZZ",
    );
    expect(secrets.redactText("aaabbbcccdddZZZZZZ")).toBe("[redacted SHORT]dddZZZZZZ");
  });

  it("handles very long values and deeply nested JSON", () => {
    const secrets = makeInjectedSecrets();
    const long = "a".repeat(48_000) + "b";
    secrets.put("instance", [
      { name: "LONG", value: long },
      { name: "KEY", value: "secret-value" },
    ]);
    expect(secrets.redactText("hello")).toBe("hello");
    expect(secrets.redactText(`x${long}y`)).toBe("x[redacted LONG]y");

    let nested: unknown = "secret-value";
    for (let depth = 0; depth < 3_000; depth++) nested = depth % 2 === 0 ? [nested] : { k: nested };
    let redacted = secrets.redact(nested);
    for (let depth = 2_999; depth >= 0; depth--) {
      redacted = depth % 2 === 0 ? (redacted as Array<unknown>)[0] : (redacted as { k: unknown }).k;
    }
    expect(redacted).toBe("[redacted KEY]");
    const untouched = { a: [{ b: "plain" }] };
    expect(secrets.redact(untouched)).toBe(untouched);
  });
});
