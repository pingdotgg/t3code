import { SourceControlProviderKind, VcsProcessTimeoutError } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

import {
  providerAuth,
  refineUnknownRemoteProvider,
  type SourceControlCliDiscoverySpec,
} from "./discovery.ts";
import type * as SourceControlProvider from "./SourceControlProvider.ts";

const context = {
  provider: {
    kind: SourceControlProviderKind.make("unknown"),
    name: "code.example.test",
    baseUrl: "https://code.example.test",
  },
  remoteName: "origin",
  remoteUrl: "https://code.example.test/group/project.git",
} satisfies SourceControlProvider.SourceControlProviderContext;

const spec = {
  type: "cli",
  kind: SourceControlProviderKind.make("gitlab"),
  label: "GitLab",
  executable: "glab",
  versionArgs: ["--version"],
  authArgs: ["auth", "status"],
  parseAuth: () => providerAuth({ status: "unknown" }),
  refineUnknownRemote: () => null,
  installHint: "Install glab.",
} satisfies SourceControlCliDiscoverySpec;

it.effect("warns when a timed-out probe leaves the source control provider unresolved", () =>
  Effect.gen(function* () {
    const logs: Array<{ level: string; message: ReadonlyArray<unknown> }> = [];
    const logger = Logger.make(({ logLevel, message }) => {
      logs.push({ level: logLevel, message: Array.isArray(message) ? message : [message] });
    });
    const result = yield* refineUnknownRemoteProvider({
      specs: [spec],
      process: {
        run: () =>
          Effect.fail(
            new VcsProcessTimeoutError({
              operation: "source-control.discovery.refine-unknown-remote",
              command: "glab",
              cwd: "/repo",
              timeoutMs: 5_000,
            }),
          ),
      },
      cwd: "/repo",
      context,
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));

    expect(result).toEqual({ provider: null, settled: false });
    expect(logs).toEqual([
      {
        level: "Warn",
        message: [
          "Source control provider detection timed out; provider remains unresolved",
          {
            provider: "gitlab",
            cwd: "/repo",
            timeoutMs: 5_000,
          },
        ],
      },
    ]);
  }),
);

it.effect(
  "does not warn about optional probe timeouts when another provider resolves the host",
  () =>
    Effect.gen(function* () {
      const warnings: Array<unknown> = [];
      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(message);
      });
      const result = yield* refineUnknownRemoteProvider({
        specs: [
          spec,
          {
            type: "managed-cli",
            kind: SourceControlProviderKind.make("forgejo"),
            label: "Forgejo",
            installHint: "Install tea.",
            probe: () => Effect.die("unused"),
            refineUnknownRemote: () =>
              Effect.succeed({
                kind: SourceControlProviderKind.make("forgejo"),
                name: "Forgejo",
                baseUrl: context.provider.baseUrl,
              }),
          },
        ],
        process: {
          run: () =>
            Effect.fail(
              new VcsProcessTimeoutError({
                operation: "source-control.discovery.refine-unknown-remote",
                command: "glab",
                cwd: "/repo",
                timeoutMs: 5_000,
              }),
            ),
        },
        cwd: "/repo",
        context,
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
      expect(result.provider?.kind).toBe("forgejo");
      expect(warnings).toEqual([]);
    }),
);
