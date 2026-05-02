import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { afterEach, expect, vi } from "vitest";

vi.mock("../processRunner", () => ({
  runProcess: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import { readFile } from "node:fs/promises";
import { runProcess } from "../processRunner.ts";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";

const mockedRunProcess = vi.mocked(runProcess);
const mockedReadFile = vi.mocked(readFile);
const layer = it.layer(AzureDevOpsCli.layer);

afterEach(() => {
  mockedRunProcess.mockReset();
  mockedReadFile.mockReset();
});

layer("AzureDevOpsCli.layer", (it) => {
  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          pullRequestId: 42,
          title: "Add Azure provider",
          sourceRefName: "refs/heads/feature/source-control",
          targetRefName: "refs/heads/main",
          status: "active",
          creationDate: "2026-01-02T00:00:00.000Z",
          _links: {
            web: {
              href: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
            },
          },
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const az = yield* AzureDevOpsCli.AzureDevOpsCli;
        return yield* az.getPullRequest({
          cwd: "/repo",
          reference: "#42",
        });
      });

      assert.strictEqual(result.number, 42);
      assert.strictEqual(result.title, "Add Azure provider");
      assert.strictEqual(result.baseRefName, "main");
      assert.strictEqual(result.headRefName, "feature/source-control");
      assert.strictEqual(result.state, "open");
      assert.deepStrictEqual(result.updatedAt._tag, Option.some(1)._tag);
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "az",
        [
          "repos",
          "pr",
          "show",
          "--detect",
          "true",
          "--id",
          "42",
          "--only-show-errors",
          "--output",
          "json",
        ],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("lists pull requests with Azure status and source branch arguments", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            pullRequestId: 7,
            title: "Merged work",
            sourceRefName: "refs/heads/feature/merged",
            targetRefName: "refs/heads/main",
            status: "completed",
            closedDate: "2026-01-03T00:00:00.000Z",
            _links: {
              web: {
                href: "https://dev.azure.com/acme/project/_git/repo/pullrequest/7",
              },
            },
          },
        ]),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const az = yield* AzureDevOpsCli.AzureDevOpsCli;
        return yield* az.listPullRequests({
          cwd: "/repo",
          headSelector: "origin:feature/merged",
          state: "merged",
          limit: 10,
        });
      });

      assert.strictEqual(result[0]?.state, "merged");
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "az",
        [
          "repos",
          "pr",
          "list",
          "--detect",
          "true",
          "--source-branch",
          "feature/merged",
          "--status",
          "completed",
          "--top",
          "10",
          "--only-show-errors",
          "--output",
          "json",
        ],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          name: "repo",
          webUrl: "https://dev.azure.com/acme/project/_git/repo",
          remoteUrl: "https://dev.azure.com/acme/project/_git/repo",
          sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
          project: {
            name: "project",
          },
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const az = yield* AzureDevOpsCli.AzureDevOpsCli;
        return yield* az.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "repo",
        });
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "project/repo",
        url: "https://dev.azure.com/acme/project/_git/repo",
        sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
      });
    }),
  );

  it.effect("creates pull requests using the body file as the Azure description", () =>
    Effect.gen(function* () {
      mockedReadFile.mockResolvedValueOnce("Generated body");
      mockedRunProcess.mockResolvedValueOnce({
        stdout: "{}",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      yield* Effect.gen(function* () {
        const az = yield* AzureDevOpsCli.AzureDevOpsCli;
        yield* az.createPullRequest({
          cwd: "/repo",
          baseBranch: "main",
          headSelector: "feature/provider",
          title: "Provider PR",
          bodyFile: "/tmp/body.md",
        });
      });

      expect(mockedReadFile).toHaveBeenCalledWith("/tmp/body.md", "utf8");
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "az",
        expect.arrayContaining(["--description", "Generated body"]),
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );
});
