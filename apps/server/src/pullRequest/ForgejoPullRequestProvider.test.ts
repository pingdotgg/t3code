import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ForgejoCli, ForgejoCliError, type ForgejoApiInput } from "../sourceControl/ForgejoCli.ts";
import { make } from "./ForgejoPullRequestProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect("uses released Gitea resolution APIs without advertising them on Forgejo", () =>
  Effect.gen(function* () {
    for (const [version, canResolve] of [
      ["1.25.3", false],
      ["1.26.0", true],
      ["16.0.0", false],
      ["1.21.0+forgejo", false],
    ] as const) {
      const calls: ForgejoApiInput[] = [];
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(ForgejoCli)({
            resolveRepository: () =>
              Effect.fail(
                new ForgejoCliError({
                  command: "fj",
                  cwd: "/repo",
                  detail: "No attachment account",
                  reason: "authentication",
                }),
              ),
            api: (input) => {
              calls.push(input);
              const body =
                input.path === "user"
                  ? { login: "reviewer" }
                  : input.path === "repos/owner/repo"
                    ? { full_name: "owner/repo", permissions: { push: false, admin: false } }
                    : input.path === "repos/owner/repo/pulls/4"
                      ? {
                          number: 4,
                          title: "PR",
                          body: "",
                          html_url: "https://git.example/owner/repo/pulls/4",
                          user: { login: "author" },
                          state: "open",
                          merged: false,
                          head: { ref: "feature", sha: "head", repo: null },
                          base: { ref: "main", sha: "base", repo: null },
                          created_at: "2026-09-18T00:00:00Z",
                          updated_at: "2026-09-18T00:00:00Z",
                          closed_at: null,
                          merged_at: null,
                          labels: [],
                        }
                      : input.path.includes("/statuses/")
                        ? []
                        : { version };
              return Effect.succeed({
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: encodeJson(body),
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              });
            },
          }),
        ),
      );
      const ref = { cwd: "/repo", repository: "owner/repo", host: "git.example", number: 4 };
      const capabilities = yield* provider.getCapabilities!(ref);
      expect(capabilities.review).toMatchObject({ resolve: canResolve, reply: false });
      if (canResolve) {
        yield* provider.setThreadResolution({ ...ref, threadId: "42", resolved: true });
        yield* provider.setThreadResolution({ ...ref, threadId: "42", resolved: false });
        expect(calls.slice(1).map(({ path, method }) => ({ path, method }))).toEqual([
          { path: "repos/owner/repo/pulls/comments/42/resolve", method: "POST" },
          { path: "repos/owner/repo/pulls/comments/42/unresolve", method: "POST" },
        ]);
        const permissions = yield* provider.getViewerPermissions!(ref);
        expect(permissions.resolve).toBe(true);
      } else {
        const result = yield* provider
          .setThreadResolution({ ...ref, threadId: "42", resolved: true })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(calls).toHaveLength(1);
      }
      expect(calls.filter((call) => call.path === "version")).toHaveLength(1);
      const detail = yield* provider.getChangeRequest(ref);
      expect(detail.title).toBe("PR");
      expect(detail.attachments?.supported).toBe(false);
      expect(detail.attachments?.reason).toContain("fj authentication");
    }
  }),
);
