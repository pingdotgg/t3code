import { assert, describe, it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";

import * as OriginCli from "./OriginCli.ts";
import * as OriginSourceControlProvider from "./OriginSourceControlProvider.ts";

type HostService = SourceControlHost.SourceControlHost["Service"];

const unusedService = <T extends object>(name: string): T =>
  new Proxy({} as T, {
    get: (_, property) => () => Effect.die(`unexpected ${name}.${String(property)} call`),
  });

const makeProvider = (api: OriginCli.OriginCli["Service"]["api"]) =>
  OriginSourceControlProvider.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeFileSystem.layer,
        Layer.succeed(SourceControlHost.SourceControlHost, {
          settings: unusedService<HostService["settings"]>("host.settings"),
          process: unusedService<HostService["process"]>("host.process"),
          git: unusedService<HostService["git"]>("host.git"),
        }),
        Layer.mock(OriginCli.OriginCli)({ api }),
      ),
    ),
  );

describe("OriginSourceControlProvider.getRepositoryCloneUrls", () => {
  it.effect("normalizes owner/name and Cursor Origin URLs before querying the API", () =>
    Effect.gen(function* () {
      const requestedPaths: Array<string> = [];
      const provider = yield* makeProvider((input, schema) => {
        requestedPaths.push(input.path);
        return Schema.decodeEffect(schema)({ name: "mic-mute-tray" }).pipe(Effect.orDie);
      });

      const validInputs = [
        "bedair81/mic-mute-tray",
        "  bedair81/mic-mute-tray.git  ",
        "https://origin.cursor.com/bedair81/mic-mute-tray.git",
        "https://origin.cursor.com/bedair81/mic-mute-tray/",
        "git@origin.cursor.com:bedair81/mic-mute-tray.git",
        "ssh://git@origin.cursor.com/bedair81/mic-mute-tray.git",
        "https://cursor.com/codebase/bedair81/mic-mute-tray",
        "https://www.cursor.com/codebase/bedair81/mic-mute-tray/",
        "https://cursor.com/codebase/bedair81/mic-mute-tray/tree/main",
        "https://cursor.com/codebase/bedair81/mic-mute-tray/blob/main/README.md",
      ];

      for (const repository of validInputs) {
        const result = yield* provider.getRepositoryCloneUrls({ cwd: "/repo", repository });
        assert.deepStrictEqual(
          result,
          {
            nameWithOwner: "bedair81/mic-mute-tray",
            url: "https://origin.cursor.com/bedair81/mic-mute-tray.git",
            sshUrl: "https://origin.cursor.com/bedair81/mic-mute-tray.git",
          },
          repository,
        );
      }

      assert.deepStrictEqual(
        requestedPaths,
        validInputs.map(() => "/v1/origin/repos/bedair81/mic-mute-tray"),
      );
    }),
  );

  it.effect("rejects malformed or foreign repository inputs with user-facing guidance", () =>
    Effect.gen(function* () {
      let apiCalls = 0;
      const provider = yield* makeProvider(() => {
        apiCalls += 1;
        return Effect.die("api should not be called for invalid repository input");
      });

      const invalidInputs = [
        "",
        "mic-mute-tray",
        "bedair81/mic-mute-tray/tree/main",
        "https://origin.cursor.com/bedair81/mic-mute-tray/tree/main",
        "https://cursor.com/codebase/bedair81",
        "https://cursor.com/settings/billing",
        "https://github.com/bedair81/mic-mute-tray",
        "git@github.com:bedair81/mic-mute-tray.git",
        "bedair81/.git",
        "../secret",
      ];

      for (const repository of invalidInputs) {
        const error = yield* Effect.flip(
          provider.getRepositoryCloneUrls({ cwd: "/repo", repository }),
        );
        assert.strictEqual(
          SourceControlProvider.userFacingSourceControlDetail(error.cause),
          "Specify an Origin repository as owner/name or a Cursor Origin URL.",
          repository,
        );
      }

      assert.strictEqual(apiCalls, 0);
    }),
  );

  it.effect("surfaces not-found and no-access details without exposing raw upstream errors", () =>
    Effect.gen(function* () {
      const notFoundProvider = yield* makeProvider(() =>
        Effect.fail(
          new OriginCli.OriginCliError({
            operation: "getRepositoryCloneUrls",
            cwd: "/repo",
            reason: "not-found",
            httpStatus: 404,
            detail: "repository not found",
          }),
        ),
      );

      const notFound = yield* Effect.flip(
        notFoundProvider.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "https://origin.cursor.com/bedair81/missing.git",
        }),
      );
      assert.strictEqual(
        SourceControlProvider.userFacingSourceControlDetail(notFound.cause),
        SourceControlProvider.repositoryNotFoundDetail("bedair81/missing"),
      );

      const forbiddenProvider = yield* makeProvider(() =>
        Effect.fail(
          new OriginCli.OriginCliError({
            operation: "getRepositoryCloneUrls",
            cwd: "/repo",
            reason: "failed",
            httpStatus: 403,
            detail: "You do not have access to bedair81/mic-mute-tray on Origin.",
          }),
        ),
      );

      const forbidden = yield* Effect.flip(
        forbiddenProvider.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "https://cursor.com/codebase/bedair81/mic-mute-tray/tree/main",
        }),
      );
      assert.strictEqual(
        SourceControlProvider.userFacingSourceControlDetail(forbidden.cause),
        "Your Cursor account does not have access to bedair81/mic-mute-tray on Origin. Ask the repository owner for access and try again.",
      );

      const serverErrorProvider = yield* makeProvider(() =>
        Effect.fail(
          new OriginCli.OriginCliError({
            operation: "getRepositoryCloneUrls",
            cwd: "/repo",
            reason: "failed",
            httpStatus: 500,
            detail: "upstream internal details",
          }),
        ),
      );

      const serverError = yield* Effect.flip(
        serverErrorProvider.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "bedair81/mic-mute-tray",
        }),
      );
      assert.strictEqual(
        SourceControlProvider.userFacingSourceControlDetail(serverError.cause),
        undefined,
      );
    }),
  );
});
