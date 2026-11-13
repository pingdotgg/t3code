import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  SecretProviderId,
  ServerSettingsError,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsCredentials from "./AzureDevOpsCredentials.ts";

const savedTokens = { "dev.azure.com/acme": "acme-pat" };

const remoteList = (remotes: ReadonlyArray<readonly [name: string, url: string]>) =>
  remotes
    .flatMap(([name, url]) => [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`])
    .join("\n");

function setup(
  input: {
    readonly origin?: string | null;
    readonly remotes?: ReadonlyArray<readonly [name: string, url: string]>;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
) {
  const remotes = input.remotes ?? (input.origin ? [["origin", input.origin] as const] : []);
  const execute = vi.fn<SourceControlHost.SourceControlHost["Service"]["git"]["execute"]>(() =>
    Effect.succeed({ ...TestSourceControlHost.processOutput(remoteList(remotes)) }),
  );
  const run = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>(() =>
    Effect.succeed(TestSourceControlHost.processOutput("")),
  );
  const host = TestSourceControlHost.layer({ process: { run }, git: { execute } });
  const layer = AzureDevOpsCli.layer.pipe(
    Layer.provideMerge(AzureDevOpsCredentials.layer),
    Layer.provideMerge(host),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.succeed(HostProcess.Environment, input.environment ?? { AZURE_EXTENSION_DIR: "/ext" }),
    ),
  );
  const save = (tokens: Record<string, SettingsSecretValue>) =>
    TestSourceControlHost.TestSourceControlHostSettings.use((settings) =>
      settings.update({ sourceControlHosts: { "azure-devops": { tokens } } }),
    );
  return { execute, run, layer, save };
}

const savedTokenOrganization = Effect.gen(function* () {
  const credentials = yield* AzureDevOpsCredentials.AzureDevOpsCredentials;
  const token = yield* credentials.savedTokenForCheckout("/w");
  return Option.map(token, (value) => value.organization).pipe(Option.getOrNull);
});

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
    const { layer, execute } = setup({ origin: "git@ssh.dev.azure.com:v3/acme/p1/r1" });
    return Effect.gen(function* () {
      const credentials = yield* AzureDevOpsCredentials.AzureDevOpsCredentials;
      assert.isTrue(Option.isNone(yield* credentials.savedTokenForCheckout("/w")));
      expect(execute).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses another Azure DevOps remote when origin is not one, as az does", () => {
    const { layer, save } = setup({
      remotes: [
        ["origin", "git@github.com:someone/web.git"],
        ["upstream", "https://dev.azure.com/acme/p1/_git/r1"],
      ],
    });
    return Effect.gen(function* () {
      yield* save(savedTokens);
      assert.strictEqual(yield* savedTokenOrganization, "dev.azure.com/acme");
    }).pipe(Effect.provide(layer));
  });

  it.effect("gives no token when az would pick an origin it has no key for", () => {
    const { layer, save } = setup({
      remotes: [
        ["origin", "https://tfs.example.com/collection/p1/_git/r1"],
        ["upstream", "https://dev.azure.com/acme/p1/_git/r1"],
      ],
    });
    return Effect.gen(function* () {
      yield* save(savedTokens);
      assert.isNull(yield* savedTokenOrganization);
    }).pipe(Effect.provide(layer));
  });

  const withUnreadableSecrets = Effect.gen(function* () {
    const host = yield* SourceControlHost.SourceControlHost;
    return yield* AzureDevOpsCredentials.make.pipe(
      Effect.provideService(SourceControlHost.SourceControlHost, {
        ...host,
        settings: {
          ...host.settings,
          getWithSecrets: () =>
            Effect.fail(new ServerSettingsError({ settingsPath: "/s", operation: "read-secret" })),
        },
      }),
    );
  });

  it.effect(
    "fails when a saved token's secret store cannot be read, rather than finding none",
    () => {
      const { layer, save } = setup({ origin: "git@ssh.dev.azure.com:v3/acme/p1/r1" });
      return Effect.gen(function* () {
        yield* save(savedTokens);
        const credentials = yield* withUnreadableSecrets;
        const error = yield* Effect.flip(credentials.savedTokenForCheckout("/w"));
        assert.strictEqual(error._tag, "SettingsSecretUnresolvedError");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("ignores an unreadable secret store when no Azure DevOps token is saved", () => {
    const { layer } = setup({ origin: "git@ssh.dev.azure.com:v3/acme/p1/r1" });
    return Effect.gen(function* () {
      const credentials = yield* withUnreadableSecrets;
      assert.isTrue(Option.isNone(yield* credentials.savedTokenForCheckout("/w")));
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the other organizations' tokens when one saved entry is malformed", () => {
    const { layer, save } = setup({ origin: "git@ssh.dev.azure.com:v3/acme/p1/r1" });
    return Effect.gen(function* () {
      yield* save({
        "dev.azure.com/acme": "acme-pat",
        "dev.azure.com/globex": 42 as unknown as SettingsSecretValue,
      });
      assert.strictEqual(yield* savedTokenOrganization, "dev.azure.com/acme");
      const credentials = yield* AzureDevOpsCredentials.AzureDevOpsCredentials;
      const error = yield* Effect.flip(
        credentials.savedToken("https://dev.azure.com/globex/p1/_git/r1"),
      );
      assert.strictEqual(error._tag, "SettingsSecretUnresolvedError");
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips a GitHub SSH origin as az does, for the Azure DevOps remote after it", () => {
    const { layer, save } = setup({
      remotes: [
        ["origin", "ssh://github.com/someone/web.git"],
        ["upstream", "https://dev.azure.com/acme/p1/_git/r1"],
      ],
    });
    return Effect.gen(function* () {
      yield* save(savedTokens);
      assert.strictEqual(yield* savedTokenOrganization, "dev.azure.com/acme");
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
      const env = run.mock.calls[0]?.[0].env;
      // A config directory with no az login accounts, so the extension cannot prefer one.
      expect(env).toEqual({
        AZURE_CONFIG_DIR: expect.stringContaining("t3code-az-"),
        AZURE_EXTENSION_DIR: "/ext",
        AZURE_DEVOPS_EXT_PAT: "acme-pat",
      });
      expect(env?.AZURE_CONFIG_DIR).not.toContain(".azure");
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
