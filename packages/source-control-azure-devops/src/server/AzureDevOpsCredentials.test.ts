import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  SecretProviderId,
  ServerSettingsError,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { PullRequestCheckoutRemote } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { ChildProcessSpawner } from "effect/process";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsCredentials from "./AzureDevOpsCredentials.ts";

const savedTokens = { "dev.azure.com/acme": "acme-pat" };

const ACME_REMOTE = "git@ssh.dev.azure.com:v3/acme/p1/r1";
const GLOBEX_REMOTE = "https://dev.azure.com/globex/p1/_git/r1";
const DETECT_PR_LIST = ["repos", "pr", "list", "--detect", "true"];

function setup(
  input: {
    readonly origin?: string;
    readonly pushUrl?: string;
  } = {},
) {
  const gitOutput =
    input.origin === undefined
      ? ""
      : `origin\t${input.origin} (fetch)\norigin\t${input.pushUrl ?? input.origin} (push)\n`;
  const git = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>(() =>
    Effect.succeed(TestSourceControlHost.processOutput(gitOutput)),
  );
  const run = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>(() =>
    Effect.succeed(TestSourceControlHost.processOutput("")),
  );
  const host = TestSourceControlHost.layer({
    process: { run: (command) => (command.command === "git" ? git(command) : run(command)) },
  });
  const layer = AzureDevOpsCli.layer.pipe(
    Layer.provideMerge(AzureDevOpsCredentials.layer),
    Layer.provideMerge(host),
    Layer.provide(NodeServices.layer),
    Layer.provide(Layer.succeed(HostProcess.Environment, { AZURE_EXTENSION_DIR: "/ext" })),
  );
  const save = (tokens: Record<string, SettingsSecretValue>) =>
    TestSourceControlHost.TestSourceControlHostSettings.use((settings) =>
      settings.update({ sourceControlHosts: { "azure-devops": { tokens } } }),
    );
  return { git, run, layer, save };
}

const savedAcmeToken = Effect.gen(function* () {
  const credentials = yield* AzureDevOpsCredentials.AzureDevOpsCredentials;
  const token = yield* credentials.savedToken(ACME_REMOTE);
  return Option.map(token, Redacted.value).pipe(Option.getOrNull);
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

  const withUnreadableSecrets = (stored = false) =>
    Effect.gen(function* () {
      const host = yield* SourceControlHost.SourceControlHost;
      return yield* AzureDevOpsCredentials.make.pipe(
        Effect.provideService(SourceControlHost.SourceControlHost, {
          ...host,
          settings: {
            ...host.settings,
            ...(stored
              ? {
                  getStored: Effect.fail(
                    new ServerSettingsError({ settingsPath: "/s", operation: "read-file" }),
                  ),
                }
              : {
                  getWithSecrets: () =>
                    Effect.fail(
                      new ServerSettingsError({ settingsPath: "/s", operation: "read-secret" }),
                    ),
                }),
          },
        }),
      );
    });

  it.effect.each([false, true])(
    "fails closed when settings cannot be read, stored snapshot: %s",
    (stored) => {
      const { layer, save } = setup({ origin: "git@ssh.dev.azure.com:v3/acme/p1/r1" });
      return Effect.gen(function* () {
        yield* save(savedTokens);
        const credentials = yield* withUnreadableSecrets(stored);
        const error = yield* Effect.flip(credentials.savedToken(ACME_REMOTE));
        assert.strictEqual(error._tag, "SettingsSecretUnresolvedError");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("ignores an unreadable secret store when no Azure DevOps token is saved", () => {
    const { layer } = setup({ origin: "git@ssh.dev.azure.com:v3/acme/p1/r1" });
    return Effect.gen(function* () {
      const credentials = yield* withUnreadableSecrets();
      assert.isTrue(Option.isNone(yield* credentials.savedToken(ACME_REMOTE)));
    }).pipe(Effect.provide(layer));
  });

  it.effect.each(["********", "previous-pat", ""])(
    "distinguishes an unavailable stored PAT from an explicitly unset token: %s",
    (stored) => {
      const { layer } = setup({ origin: "git@ssh.dev.azure.com:v3/acme/p1/r1" });
      return Effect.gen(function* () {
        const host = yield* SourceControlHost.SourceControlHost;
        const settings = yield* host.settings.getStored;
        const credentials = yield* AzureDevOpsCredentials.make.pipe(
          Effect.provideService(SourceControlHost.SourceControlHost, {
            ...host,
            settings: {
              ...host.settings,
              getStored: Effect.succeed({
                ...settings,
                sourceControlHosts: {
                  "azure-devops": { tokens: { "dev.azure.com/acme": stored } },
                },
              }),
              getWithSecrets: () =>
                Effect.succeed({
                  ...settings,
                  sourceControlHosts: { "azure-devops": { tokens: { "dev.azure.com/acme": "" } } },
                }),
            },
          }),
        );
        if (stored === "") assert.isTrue(Option.isNone(yield* credentials.savedToken(ACME_REMOTE)));
        else
          assert.strictEqual(
            (yield* Effect.flip(credentials.savedToken(ACME_REMOTE)))._tag,
            "SettingsSecretUnresolvedError",
          );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("keeps the other organizations' tokens when one saved entry is malformed", () => {
    const { layer, save } = setup({ origin: "git@ssh.dev.azure.com:v3/acme/p1/r1" });
    return Effect.gen(function* () {
      yield* save({
        "dev.azure.com/acme": "acme-pat",
        "dev.azure.com/globex": 42 as unknown as SettingsSecretValue,
      });
      assert.strictEqual(yield* savedAcmeToken, "acme-pat");
      const credentials = yield* AzureDevOpsCredentials.AzureDevOpsCredentials;
      const error = yield* Effect.flip(
        credentials.savedToken("https://dev.azure.com/globex/p1/_git/r1"),
      );
      assert.strictEqual(error._tag, "SettingsSecretUnresolvedError");
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
      const error = yield* Effect.flip(cli.execute({ cwd: "/w", args: DETECT_PR_LIST }));
      assert.strictEqual(error._tag, "AzureDevOpsSavedTokenUnreadableError");
      expect(run).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  });

  it.effect.each(["checkout", "explicit remote", "project remote"] as const)(
    "gives az the token for the %s organization",
    (source) => {
      const { layer, git, run, save } = setup({ origin: ACME_REMOTE, pushUrl: GLOBEX_REMOTE });
      return Effect.gen(function* () {
        yield* save({ ...savedTokens, "dev.azure.com/globex": "globex-pat" });
        const cli = yield* AzureDevOpsCli.AzureDevOpsCli;
        const execute = cli.execute({
          cwd: "/w",
          args: DETECT_PR_LIST,
          ...(source === "explicit remote" ? { remoteUrl: GLOBEX_REMOTE } : {}),
        });
        yield* source === "project remote"
          ? execute.pipe(Effect.provideService(PullRequestCheckoutRemote, GLOBEX_REMOTE))
          : execute;
        const command = run.mock.calls[0]?.[0];
        const env = command?.env;
        expect(command?.args).toEqual(
          expect.arrayContaining([
            "--detect",
            "false",
            "--organization",
            source === "checkout" ? "https://dev.azure.com/acme" : "https://dev.azure.com/globex",
          ]),
        );
        expect(git).toHaveBeenCalledTimes(source === "checkout" ? 1 : 0);
        // A config directory with no az login accounts, so the extension cannot prefer one.
        expect(env).toEqual({
          AZURE_CONFIG_DIR: expect.stringContaining("t3code-az-"),
          AZURE_EXTENSION_DIR: "/ext",
          AZURE_DEVOPS_EXT_PAT: source === "checkout" ? "acme-pat" : "globex-pat",
        });
        expect(env?.AZURE_CONFIG_DIR).not.toContain(".azure");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("stops before launching az if checkout remote discovery fails", () => {
    const { git, layer, run, save } = setup({ origin: ACME_REMOTE });
    git.mockReturnValueOnce(
      Effect.succeed(
        TestSourceControlHost.processOutput("", { exitCode: ChildProcessSpawner.ExitCode(128) }),
      ),
    );
    return Effect.gen(function* () {
      yield* save(savedTokens);
      const cli = yield* AzureDevOpsCli.AzureDevOpsCli;
      const error = yield* Effect.flip(cli.execute({ cwd: "/w", args: DETECT_PR_LIST }));
      assert.strictEqual(error._tag, "AzureDevOpsRemoteDiscoveryError");
      expect(git).toHaveBeenCalledTimes(1);
      expect(run).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses an explicit organization even when the checkout points elsewhere", () => {
    const { git, layer, run, save } = setup({ origin: ACME_REMOTE });
    return Effect.gen(function* () {
      yield* save({ ...savedTokens, "dev.azure.com/globex": "globex-pat" });
      const cli = yield* AzureDevOpsCli.AzureDevOpsCli;
      yield* cli.execute({
        cwd: "/w",
        remoteUrl: ACME_REMOTE,
        args: [...DETECT_PR_LIST, "--org=https://dev.azure.com/globex"],
      });
      expect(git).not.toHaveBeenCalled();
      expect(run.mock.calls[0]?.[0].env?.AZURE_DEVOPS_EXT_PAT).toBe("globex-pat");
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves az's own credentials alone in another organization", () => {
    const { layer, run, save } = setup({ origin: "https://dev.azure.com/globex/p1/_git/r1" });
    return Effect.gen(function* () {
      yield* save(savedTokens);
      const cli = yield* AzureDevOpsCli.AzureDevOpsCli;
      yield* cli.execute({ cwd: "/w", args: DETECT_PR_LIST });
      expect(run.mock.calls[0]?.[0].env).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });
});
