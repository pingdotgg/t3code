import { SourceControlProviderKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";

const unknownContext = (baseUrl: string) => ({
  provider: { kind: SourceControlProviderKind.make("unknown"), name: "Unknown", baseUrl },
  remoteName: "origin",
  remoteUrl: "git@code.example.test:team/project.git",
});

// The default host dies on any command, so refinement never reaches `gh`.
const makeDiscovery = (credential: GitHubRest.GitHubRest["Service"]["credential"]) =>
  GitHubSourceControlProvider.makeDiscovery.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(GitHubRest.GitHubRest)({ credential }),
        Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({ enabled: false }),
        TestSourceControlHost.layer(),
      ),
    ),
    Effect.provideService(HostProcess.Environment, {}),
  );

it.effect.each([
  { name: "a credential", credential: "found", claimed: true },
  { name: "a host turned off in Settings", credential: "disabled", claimed: true },
  { name: "no credential", credential: "missing", claimed: false },
] as const)("claims a custom-host remote with $name", (scenario) =>
  Effect.gen(function* () {
    const hosts: Array<string> = [];
    const discovery = yield* makeDiscovery((host) => {
      hosts.push(host);
      return scenario.credential === "found"
        ? Effect.succeed({ token: Redacted.make("token"), fingerprint: `${host}:fingerprint` })
        : scenario.credential === "disabled"
          ? Effect.fail(new GitHubCredentials.GitHubHostDisabledError({ host }))
          : Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host }));
    });
    if (discovery.type !== "managed-cli") return assert.fail("expected a managed CLI");
    const provider = yield* discovery.refineUnknownRemote({
      cwd: "/repo",
      context: unknownContext("https://code.example.test"),
    });
    assert.deepStrictEqual(
      provider,
      scenario.claimed
        ? {
            kind: SourceControlProviderKind.make("github"),
            name: "GitHub Self-Hosted",
            baseUrl: "https://code.example.test",
          }
        : null,
    );
    assert.deepStrictEqual(hosts, ["code.example.test"]);
  }),
);

it.effect("asks for no credential when the identity resolver left the base URL empty", () =>
  Effect.gen(function* () {
    const hosts: Array<string> = [];
    const discovery = yield* makeDiscovery((host) => {
      hosts.push(host);
      return Effect.succeed({ token: Redacted.make("token"), fingerprint: `${host}:fingerprint` });
    });
    if (discovery.type !== "managed-cli") return assert.fail("expected a managed CLI");
    assert.strictEqual(
      yield* discovery.refineUnknownRemote({ cwd: "/repo", context: unknownContext("") }),
      null,
    );
    assert.deepStrictEqual(hosts, []);
  }),
);
