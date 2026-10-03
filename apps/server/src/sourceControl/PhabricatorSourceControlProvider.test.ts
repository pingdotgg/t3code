import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcess, type VcsProcessInput } from "../vcs/VcsProcess.ts";
import { make, makeDiscovery } from "./PhabricatorSourceControlProvider.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const context = {
  provider: { kind: "unknown" as const, name: "Unknown", baseUrl: "" },
  remoteName: "origin",
  remoteUrl: "git@reviews.example:repo.git",
};
const dependencies = (config: string, requests: VcsProcessInput[] = []) =>
  Layer.mergeAll(
    Path.layer,
    FileSystem.layerNoop({ readFileString: () => Effect.succeed(config) }),
    Layer.mock(VcsProcess)({
      run: (input) => {
        requests.push(input);
        return Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdoutTruncated: false,
          stderrTruncated: false,
          stderr: "",
          stdout: encode({
            error: null,
            errorMessage: null,
            response:
              input.operation === "user.whoami"
                ? { userName: "alice", phid: "PHID-USER-author" }
                : {
                    data: [
                      {
                        id: 42,
                        phid: "PHID-DREV-42",
                        fields: {
                          title: "Feature",
                          uri: "https://reviews.example/D42",
                          authorPHID: "PHID-USER-author",
                          status: { value: "published", closed: true },
                          diffPHID: null,
                          summary: "",
                          testPlan: "",
                          isDraft: false,
                          dateCreated: 1700000000,
                          dateModified: 1700000010,
                        },
                      },
                    ],
                    cursor: { after: null },
                  },
          }),
        });
      },
    }),
  );

it.effect("refines arbitrary SSH hosts from .arcconfig even without a detected base URL", () =>
  Effect.gen(function* () {
    const discovery = yield* makeDiscovery.pipe(
      Effect.provide(dependencies('{"phabricator.uri":"http://reviews.example:8080/"}')),
    );
    expect(yield* discovery.refineUnknownRemote({ cwd: "/repo", context })).toEqual({
      kind: "phabricator",
      name: "Phabricator",
      baseUrl: "http://reviews.example:8080",
    });
    expect(
      yield* discovery.refineUnknownRemote({
        cwd: "/repo",
        context: { ...context, remoteUrl: "git@other.example:repo.git" },
      }),
    ).toBeNull();
  }),
);

it.effect.each(["{}", "invalid json", '{"phabricator.uri":"javascript:alert(1)"}'])(
  "ignores unusable arc configuration: %s",
  (config) =>
    Effect.gen(function* () {
      const discovery = yield* makeDiscovery.pipe(Effect.provide(dependencies(config)));
      expect(yield* discovery.refineUnknownRemote({ cwd: "/repo", context })).toBeNull();
    }),
);

it.effect("returns live revision status through source control and checks out with arc patch", () =>
  Effect.gen(function* () {
    const requests: VcsProcessInput[] = [];
    const api = yield* make.pipe(
      Effect.provide(dependencies('{"phabricator.uri":"https://reviews.example/"}', requests)),
    );
    const input = {
      cwd: "/repo",
      reference: "D42",
      context: {
        ...context,
        provider: {
          kind: "phabricator" as const,
          name: "Phabricator",
          baseUrl: "https://reviews.example",
        },
      },
    };
    expect(yield* api.getChangeRequest(input)).toMatchObject({
      provider: "phabricator",
      number: 42,
      state: "merged",
    });
    yield* api.checkoutChangeRequest(input);
    expect(requests.at(-1)?.args).toEqual(["patch", "D42"]);
    expect(
      yield* api
        .getChangeRequest({ ...input, reference: "https://other.example/D42" })
        .pipe(Effect.flip),
    ).toMatchObject({ detail: "This revision belongs to a different review server." });
    expect(
      yield* api.getChangeRequest({ ...input, reference: "invalid" }).pipe(Effect.flip),
    ).toMatchObject({ operation: "getChangeRequest" });
  }),
);

it.effect("refines git protocol remotes from arc configuration", () =>
  Effect.gen(function* () {
    const discovery = yield* makeDiscovery.pipe(
      Effect.provide(dependencies('{"phabricator.uri":"https://reviews.example/"}')),
    );
    expect(
      yield* discovery.refineUnknownRemote({
        cwd: "/repo",
        context: { ...context, remoteUrl: "git://reviews.example/repo.git" },
      }),
    ).toEqual({
      kind: "phabricator",
      name: "Phabricator",
      baseUrl: "https://reviews.example",
    });
  }),
);
