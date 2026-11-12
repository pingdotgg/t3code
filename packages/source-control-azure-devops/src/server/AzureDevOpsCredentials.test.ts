import { assert, describe, expect, it, vi } from "@effect/vitest";
import { SecretProviderId, type SettingsSecretValue } from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsCredentials from "./AzureDevOpsCredentials.ts";

const savedTokens = { "dev.azure.com/acme": "acme-pat" };

function setup(input: { readonly origin?: string | null } = {}) {
  const readConfigValue = vi.fn<
    SourceControlHost.SourceControlHost["Service"]["git"]["readConfigValue"]
  >((_cwd, key) => Effect.succeed(key === "remote.origin.url" ? (input.origin ?? null) : null));
  const run = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>(() =>
    Effect.succeed(TestSourceControlHost.processOutput("")),
  );
  const host = TestSourceControlHost.layer({ process: { run }, git: { readConfigValue } });
  const layer = Layer.mergeAll(
    AzureDevOpsCli.layer.pipe(
      Layer.provideMerge(AzureDevOpsCredentials.layer),
      Layer.provideMerge(host),
    ),
  );
  const save = (tokens: Record<string, SettingsSecretValue>) =>
    TestSourceControlHost.TestSourceControlHostSettings.use((settings) =>
      settings.update({ sourceControlHosts: { "azure-devops": { tokens } } }),
    );
  return { readConfigValue, run, layer, save };
}

describe("AzureDevOpsCredentials", () => {
  it.effect("finds the token saved for an organization and no other", () => {
    const { layer, save } = setup();
    return Effect.gen(function* () {
      yield* save(savedTokens);
      const credentials = yield* AzureDevOpsCredentials.AzureDevOpsCredentials;
      const acme = yield* credentials.savedToken(
        "https://dev.azure.com/acme/p1/_apis/git/repositories/r1/items",
      );
      assert.strictEqual(Option.map(acme, Redacted.value).pipe(Option.getOrNull), "acme-pat");
      assert.isTrue(
        Option.isNone(yield* credentials.savedToken("https://dev.azure.com/globex/p1/_git/r1")),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads no remote when no token is saved", () => {
    const { layer, readConfigValue } = setup({ origin: "git@ssh.dev.azure.com:v3/acme/p1/r1" });
    return Effect.gen(function* () {
      const credentials = yield* AzureDevOpsCredentials.AzureDevOpsCredentials;
      assert.isTrue(Option.isNone(yield* credentials.savedTokenForCheckout("/w")));
      expect(readConfigValue).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  });
});

describe("AzureDevOpsCli with a saved token", () => {
  it.effect("runs nothing when the organization's saved secret cannot be read", () => {
    const { layer, run, save } = setup({ origin: "git@ssh.dev.azure.com:v3/acme/p1/r1" });
    return Effect.gen(function* () {
      yield* save({
        "dev.azure.com/acme": { provider: SecretProviderId.make("missing"), reference: "acme-pat" },
      });
      const cli = yield* AzureDevOpsCli.AzureDevOpsCli;
      const error = yield* Effect.flip(cli.execute({ cwd: "/w", args: ["repos", "pr", "list"] }));
      assert.strictEqual(error._tag, "AzureDevOpsSavedTokenUnreadableError");
      expect(run).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  });

  it.effect("gives az the token for the checkout's organization", () => {
    const { layer, run, save } = setup({ origin: "git@ssh.dev.azure.com:v3/acme/p1/r1" });
    return Effect.gen(function* () {
      yield* save(savedTokens);
      const cli = yield* AzureDevOpsCli.AzureDevOpsCli;
      yield* cli.execute({ cwd: "/w", args: ["repos", "pr", "list"] });
      expect(run.mock.calls[0]?.[0].env).toEqual({ AZURE_DEVOPS_EXT_PAT: "acme-pat" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves az's own credentials alone in another organization", () => {
    const { layer, run, save } = setup({ origin: "https://dev.azure.com/globex/p1/_git/r1" });
    return Effect.gen(function* () {
      yield* save(savedTokens);
      const cli = yield* AzureDevOpsCli.AzureDevOpsCli;
      yield* cli.execute({ cwd: "/w", args: ["repos", "pr", "list"] });
      expect(run.mock.calls[0]?.[0].env).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });
});
