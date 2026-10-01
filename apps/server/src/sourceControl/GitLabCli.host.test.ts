import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitLabCli from "./GitLabCli.ts";

const decodeCalls = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        args: Schema.Array(Schema.String),
        host: Schema.NullOr(Schema.String),
      }),
    ),
  ),
);

it.effect.each([
  {
    host: "gitlab.127.0.0.1.nip.io:18880",
    profile: "gitlab.127.0.0.1.nip.io",
    notFound: true,
    storedUser: false,
    mergeRequest: true,
  },
  { host: "gitlab.com", profile: "gitlab.com" },
  { host: "gitlab-b.example", profile: "gitlab-b.example" },
  { host: "gitlab-b.example:443", profile: "gitlab-b.example", apiHost: "gitlab-b.example" },
  { host: "gitlab-b.example", profile: "gitlab-b.example", apiHost: "gitlab-b.example:8443" },
  { host: "gitlab.com", profile: "gitlab.corp.example", originHost: "gitlab.corp.example" },
  { host: "gitlab-b.example:8443", profile: "gitlab-b.example", apiHost: "gitlab-b.example:8443" },
  {
    host: "gitlab-b.example:8443",
    profile: "ssh.gitlab-b.example",
    originHost: "ssh.gitlab-b.example",
    apiHost: "gitlab-b.example:8443",
  },
  {
    host: "gitlab-missing.example",
    profile: "gitlab-missing.example",
    notFound: true,
    storedUser: false,
  },
  { host: "gitlab-b.example:8443", profile: "gitlab-b.example", notFound: true, storedUser: false },
  { host: "gitlab-b.example", profile: "gitlab-b.example", notFound: true, storedUser: true },
  {
    host: "gitlab-b.example",
    profile: "gitlab-b.example",
    apiHost: "gitlab-wrong.example",
    mismatch: true,
  },
  {
    host: "gitlab-missing.example",
    profile: "gitlab-missing.example",
    notFound: true,
    storedUser: false,
    mergeRequest: true,
  },
  {
    host: "gitlab-b.example:8443",
    profile: "gitlab-b.example",
    notFound: true,
    storedUser: false,
    mergeRequest: true,
  },
  {
    host: "gitlab-b.example",
    profile: "gitlab-b.example",
    apiHost: "gitlab-b.example:8443",
    notFound: true,
    storedUser: false,
    mergeRequest: true,
  },
  {
    host: "gitlab-b.example",
    profile: "gitlab-b.example",
    notFound: true,
    storedUser: true,
    mergeRequest: true,
  },
  {
    host: "gitlab-b.example",
    profile: "gitlab-b.example",
    apiHost: "gitlab-b.example:8443",
    notFound: true,
    storedUser: false,
    mergeRequest: true,
    numberReference: true,
  },
])(
  "enforces lookup for $host through a fake glab process (profile: $profile, missing: $notFound, MR: $mergeRequest, number: $numberReference)",
  ({
    host,
    profile,
    originHost,
    apiHost,
    notFound,
    storedUser,
    mismatch,
    mergeRequest,
    numberReference,
  }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-fake-glab-" });
      const executable = path.join(directory, "glab.mjs");
      const recording = path.join(directory, "calls.json");
      yield* fileSystem.writeFileString(
        executable,
        `import fs from "node:fs";
const args = process.argv.slice(2);
const host = process.env.GITLAB_HOST ?? null;
const calls = fs.existsSync(process.env.FAKE_GLAB_RECORDING) ? JSON.parse(fs.readFileSync(process.env.FAKE_GLAB_RECORDING, "utf8")) : [];
calls.push({ args, host });
fs.writeFileSync(process.env.FAKE_GLAB_RECORDING, JSON.stringify(calls));
const configuredProfile = process.env.FAKE_GLAB_PROFILE;
if (args[0] === "config") {
  if (args[4] === configuredProfile) {
    process.stdout.write(args[2] === "api_host" ? process.env.FAKE_GLAB_API_HOST : process.env.USER || process.env.FAKE_GLAB_USER);
  } else if (args[2] === "user") {
    process.stdout.write(process.env.USER || "");
  }
} else {
  const flag = args.indexOf("--hostname");
  const explicit = flag === -1 ? undefined : args[flag + 1];
  if (explicit?.includes(":")) {
    process.stderr.write("error parsing --hostname: invalid hostname.");
    process.exitCode = 1;
  } else {
    const defaultHost = host ?? "gitlab.com";
    const remote = process.env.FAKE_GLAB_REMOTE;
    const selected = explicit ?? (remote && (defaultHost === "gitlab.com" || remote === defaultHost) ? remote : defaultHost);
    const destination = selected === configuredProfile ? process.env.FAKE_GLAB_API_HOST || selected : selected;
    if (process.env.FAKE_GLAB_NOT_FOUND === "true") {
      process.stderr.write("404 Project Not Found\\n");
      process.exitCode = 1;
    } else {
      process.stdout.write(JSON.stringify({
        path_with_namespace: "alex/repo",
        web_url: "https://" + destination + "/alex/repo",
        http_url_to_repo: "https://" + destination + "/alex/repo.git",
        ssh_url_to_repo: "git@" + selected + ":alex/repo.git"
      }));
    }
  }
}
`,
      );
      const fakeRunner = Layer.effect(
        ProcessRunner.ProcessRunner,
        Effect.gen(function* () {
          const runner = yield* ProcessRunner.make();
          return ProcessRunner.ProcessRunner.of({
            run: (input) => {
              expect(input.command).toBe("glab");
              return runner.run({
                ...input,
                command: process.execPath,
                args: [executable, ...input.args],
                env: {
                  ...input.env,
                  USER: input.env?.USER ?? "local-os-user",
                  FAKE_GLAB_RECORDING: recording,
                  FAKE_GLAB_PROFILE: profile,
                  FAKE_GLAB_REMOTE: originHost ?? "",
                  FAKE_GLAB_API_HOST: apiHost ?? "",
                  FAKE_GLAB_USER: storedUser === false ? "" : "alex",
                  FAKE_GLAB_NOT_FOUND: String(notFound === true),
                },
              });
            },
          });
        }),
      ).pipe(Layer.provide(NodeServices.layer));
      const glab = yield* GitLabCli.make.pipe(
        Effect.provide(
          Layer.effect(VcsProcess.VcsProcess, VcsProcess.make).pipe(Layer.provide(fakeRunner)),
        ),
      );
      const context = {
        provider: {
          kind: "gitlab" as const,
          name: "GitLab",
          baseUrl: `https://${originHost ?? host}`,
        },
        remoteName: "origin",
        remoteUrl: `git@${originHost ?? host}:team/repo.git`,
      };
      const repositoryLookup = glab.getRepositoryCloneUrls({
        cwd: directory,
        host,
        repository: "alex/repo",
        ...(originHost
          ? {
              context: {
                provider: {
                  kind: "gitlab" as const,
                  name: "GitLab",
                  baseUrl: `https://${originHost}`,
                },
                remoteName: "origin",
                remoteUrl: `git@${originHost}:team/repo.git`,
              },
            }
          : {}),
      });
      const lookup = mergeRequest
        ? glab
            .getMergeRequest({
              cwd: directory,
              reference: numberReference ? "1" : `https://${host}/team/repo/-/merge_requests/1`,
              context,
            })
            .pipe(Effect.asVoid)
        : repositoryLookup.pipe(Effect.asVoid);

      if (notFound) {
        const error = yield* lookup.pipe(Effect.flip);
        if (mergeRequest) {
          expect(error.detail).toBe(
            storedUser
              ? `Merge request !1 was not found or is inaccessible on ${host}. Check the MR number or URL and try again.`
              : `If private, run \`glab auth login --hostname ${new URL(`https://${host}`).hostname}${
                  host.includes(":") || apiHost ? ` --api-host ${apiHost ?? host}` : ""
                }\` and retry. Merge request !1 was not found or is inaccessible on ${host}.`,
          );
        }
        if (mergeRequest && host === "gitlab.127.0.0.1.nip.io:18880") {
          // The longest local split-host case keeps the complete login action first,
          // shortens the MR URL to !1, and does not repeat provider diagnostics.
          expect(error.detail).toHaveLength(204);
          expect(error.detail.split(" and retry.")[0]).toBe(
            "If private, run `glab auth login --hostname gitlab.127.0.0.1.nip.io --api-host gitlab.127.0.0.1.nip.io:18880`",
          );
          expect(error.detail).not.toContain("/team/repo/-/merge_requests/");
          expect(error.detail).not.toContain("GitLab CLI failed");
        }
        expect(error.detail).toContain(
          mergeRequest ? "not found" : "Repository not found or inaccessible on GitLab.",
        );
        if (storedUser) {
          expect(error.detail).not.toContain("glab auth login");
        } else {
          expect(error.detail).toContain(
            `glab auth login --hostname ${new URL(`https://${host}`).hostname}`,
          );
          if (host.includes(":")) {
            expect(error.detail).toContain(`--api-host ${host}`);
          } else if (apiHost) {
            expect(error.detail).toContain(`--api-host ${apiHost}`);
          }
        }
        expect(error.cause).toMatchObject({
          _tag: "VcsProcessExitError",
          exitCode: 1,
          failureKind: "not-found",
          detail: "Not found on GitLab.",
        });
      } else if (mismatch) {
        const error = yield* lookup.pipe(Effect.flip);
        expect(error.detail).toContain("different host");
      } else {
        const result = yield* repositoryLookup;
        expect(result.url).toBe(`https://${apiHost ?? host}/alex/repo`);
      }
      const calls = decodeCalls(yield* fileSystem.readFileString(recording));
      const lookupCalls = calls.filter((call) => call.args[0] === (mergeRequest ? "mr" : "api"));
      expect(lookupCalls).toHaveLength(1);
      if (!mergeRequest)
        expect(lookupCalls[0]?.host).toBe(
          originHost && apiHost === host ? profile : new URL(`https://${host}`).hostname,
        );
      expect(
        calls
          .filter((call) => call.args[0] === "config")
          .every((call) => ["api_host", "user"].includes(call.args[2] ?? "")),
      ).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
);
