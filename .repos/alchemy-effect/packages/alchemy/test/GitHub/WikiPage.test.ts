import * as GitHub from "@/GitHub/index.ts";
import { fromToken } from "@/GitHub/Credentials.ts";
import type { WikiPage, WikiPageProps } from "@/GitHub/WikiPage.ts";
import { WikiPageProvider } from "@/GitHub/WikiPage.ts";
import {
  deleteWikiPage,
  readWikiPage,
  syncWikiPage,
  wikiRepository,
  type WikiRepository,
} from "@/GitHub/WikiPage.ts";
import * as Provider from "@/Provider.ts";
import { exec } from "@/Util/exec.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "alchemy-test";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Output from "@/Output.ts";
import * as Test from "@/Test/Alchemy.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test";
if (!["alchemy-run-test", "alchemy-run-test-2"].includes(owner)) {
  throw new Error(
    "GITHUB_TEST_OWNER must be alchemy-run-test or alchemy-run-test-2",
  );
}

const { test } = Test.make({
  providers: GitHub.providers({ baseUrl: "github.com" }),
});

// Repositories are retained because the testing token lacks delete_repo.
const fixture = (suffix: string) =>
  GitHub.Repository("Repo", {
    owner,
    name: `alchemy-pr-1578-wiki-${suffix}`,
    visibility: "public",
    hasWiki: true,
    autoInit: true,
  });

const repoNameOf = (repo: GitHub.Repository) =>
  Output.map(repo.fullName, (fullName) => fullName.split("/")[1]!);

const git = Effect.fn(
  function* (cwd: string, ...args: string[]) {
    const handle = yield* ChildProcess.make("git", args, {
      cwd,
      env: { GIT_TERMINAL_PROMPT: "0" },
      extendEnv: true,
    });
    const [exitCode, stdout, stderr] = yield* Effect.all(
      [
        handle.exitCode,
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
      ],
      { concurrency: 3 },
    );
    if (exitCode !== 0) {
      return yield* Effect.fail(
        new Error(`git ${args[0]} exited ${exitCode}: ${stderr}`),
      );
    }
    return stdout;
  },
  Effect.scoped,
  Effect.timeout("30 seconds"),
);

// Read the public wiki's Git repository independently of the resource provider.
const getPage = (repository: string, title: string, extension = "md") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* Effect.sync(() => process.cwd());
    const directory = yield* fs.makeTempDirectoryScoped({
      directory: cwd,
      prefix: ".wiki-test-",
    });
    yield* git(
      directory,
      "clone",
      "--quiet",
      `https://github.com/${owner}/${repository}.wiki.git`,
      "wiki",
    );
    const wiki = path.join(directory, "wiki");
    const file = `${title.replace(/\s+/g, "-")}.${extension}`;
    if (!(yield* fs.exists(path.join(wiki, file)))) return undefined;
    return {
      content: yield* fs.readFileString(path.join(wiki, file)),
      sha: (yield* git(wiki, "log", "-1", "--format=%H", "--", file)).trim(),
    };
  }).pipe(Effect.scoped);

test.provider(
  "create and update wiki page",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (content: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const repo = yield* fixture("lifecycle");
            const page = yield* GitHub.WikiPage("Page", {
              owner,
              repository: repoNameOf(repo),
              title: "Home",
              content,
              allowDelete: true,
            });
            return { repo, page };
          }),
        );

      const created = yield* deploy("Welcome to the wiki!");
      expect(created.page.title).toBe("Home");
      expect(created.page.pageName).toBe("Home");
      expect(created.page.htmlUrl).toBe(
        `https://github.com/${owner}/alchemy-pr-1578-wiki-lifecycle/wiki/Home`,
      );
      expect(
        (yield* getPage("alchemy-pr-1578-wiki-lifecycle", "Home"))?.content,
      ).toBe("Welcome to the wiki!");

      const updated = yield* deploy("# Updated Content\n\nThis is updated!");
      expect(updated.page.sha).not.toBe(created.page.sha);
      expect(
        (yield* getPage("alchemy-pr-1578-wiki-lifecycle", "Home"))?.content,
      ).toBe("# Updated Content\n\nThis is updated!");

      yield* stack.destroy();
      expect(
        yield* getPage("alchemy-pr-1578-wiki-lifecycle", "Home"),
      ).toBeUndefined();
    }),
  { timeout: 120_000 },
);

test.provider(
  "create page with custom format",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const result = yield* stack.deploy(
        Effect.gen(function* () {
          const repo = yield* fixture("format");
          return yield* GitHub.WikiPage("Page", {
            owner,
            repository: repoNameOf(repo),
            title: "API Documentation",
            content: `
              = API Documentation

              == Overview

              The API provides...
            `,
            format: "asciidoc",
            message: "Add API documentation",
            allowDelete: true,
          });
        }),
      );
      expect(result.title).toBe("API Documentation");
      expect(result.pageName).toBe("API-Documentation");
      expect(
        (yield* getPage(
          "alchemy-pr-1578-wiki-format",
          "API Documentation",
          "asciidoc",
        ))?.content,
      ).toBe("= API Documentation\n\n== Overview\n\nThe API provides...");
      yield* stack.destroy();
      expect(
        yield* getPage(
          "alchemy-pr-1578-wiki-format",
          "API Documentation",
          "asciidoc",
        ),
      ).toBeUndefined();
    }),
  { timeout: 120_000 },
);

test.provider(
  "preserve page when allowDelete is false (default)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (allowDelete?: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const repo = yield* fixture("preserve");
            return yield* GitHub.WikiPage("Page", {
              owner,
              repository: repoNameOf(repo),
              title: "Documentation",
              content: "Important documentation that should be preserved",
              allowDelete,
            });
          }),
        );
      const created = yield* deploy();
      yield* stack.destroy();
      const retained = yield* getPage(
        "alchemy-pr-1578-wiki-preserve",
        "Documentation",
      );
      expect(retained?.sha).toBe(created.sha);
      expect(retained?.content).toBe(
        "Important documentation that should be preserved",
      );

      // Re-manage the retained page with deletion enabled to verify cleanup.
      yield* deploy(true);
      yield* stack.destroy();
      expect(
        yield* getPage("alchemy-pr-1578-wiki-preserve", "Documentation"),
      ).toBeUndefined();
    }),
  { timeout: 120_000 },
);

test.provider(
  "replace page when title changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (title: string, content: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const repo = yield* fixture("replace");
            return yield* GitHub.WikiPage("Page", {
              owner,
              repository: repoNameOf(repo),
              title,
              content,
              allowDelete: true,
            });
          }),
        );
      const created = yield* deploy("Getting Started", "Original guide");
      expect(created.title).toBe("Getting Started");
      const replaced = yield* deploy(
        "Quick Start",
        "New guide with different title",
      );
      expect(replaced.title).toBe("Quick Start");
      expect(replaced.pageName).toBe("Quick-Start");
      expect(
        yield* getPage("alchemy-pr-1578-wiki-replace", "Getting Started"),
      ).toBeUndefined();
      expect(
        (yield* getPage("alchemy-pr-1578-wiki-replace", "Quick Start"))
          ?.content,
      ).toBe("New guide with different title");
      yield* stack.destroy();
      expect(
        yield* getPage("alchemy-pr-1578-wiki-replace", "Quick Start"),
      ).toBeUndefined();
    }),
  { timeout: 120_000 },
);

// Deterministic Git-transport tests over local bare-repository fixtures.
const props: WikiPageProps = {
  owner: "alchemy-run-test",
  repository: "alchemy-pr-1578-wiki-unit",
  title: "Getting Started",
  content: "First revision",
  allowDelete: true,
};
const token = "wiki-fixture-secret";

const fixtureGit = Effect.fn(
  function* (cwd: string, ...args: string[]) {
    const env = yield* Effect.sync(() => ({
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Wiki fixture",
      GIT_AUTHOR_EMAIL: "wiki-fixture@example.com",
      GIT_COMMITTER_NAME: "Wiki fixture",
      GIT_COMMITTER_EMAIL: "wiki-fixture@example.com",
    }));
    const result = yield* exec(
      ChildProcess.make("git", args, { cwd, env, extendEnv: false }),
    );
    expect(result.exitCode).toBe(0);
    return result.stdout;
  },
  Effect.scoped,
  Effect.timeout("20 seconds"),
);

const gitFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "alchemy-wiki-fixture-",
  });
  const remote = path.join(directory, "fixture.wiki.git");
  const seed = path.join(directory, "seed");
  yield* fixtureGit(
    directory,
    "init",
    "--bare",
    "--initial-branch=main",
    remote,
  );
  yield* fixtureGit(directory, "clone", remote, seed);
  yield* fs.writeFileString(
    path.join(seed, "Bootstrap.md"),
    "Unmanaged bootstrap page",
  );
  yield* fixtureGit(seed, "add", "Bootstrap.md");
  yield* fixtureGit(seed, "commit", "-m", "Bootstrap wiki");
  yield* fixtureGit(seed, "push", "origin", "HEAD");
  const repository: WikiRepository = {
    remote,
    htmlUrl: `https://github.com/${props.owner}/${props.repository}/wiki`,
    token: Redacted.make(token),
  };
  return { fs, path, directory, seed, repository };
});

const describe = layer(NodeServices.layer, { excludeTestServices: true });

describe("WikiPage Git fixtures", (it) => {
  it.effect(
    "runs provider create, recovery, adoption, update, replacement, and delete against Git",
    () =>
      Effect.gen(function* () {
        const { repository } = yield* gitFixture;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const remote = `https://github.com/${props.owner}/${props.repository}.wiki.git`;
        const localTransport = ChildProcessSpawner.make((command) =>
          spawner.spawn(
            command._tag === "StandardCommand"
              ? ChildProcess.make(
                  command.command,
                  command.args.map((arg) =>
                    arg === remote ? repository.remote : arg,
                  ),
                  command.options,
                )
              : command,
          ),
        );
        yield* Effect.gen(function* () {
          const provider =
            yield* Provider.Provider<WikiPage>("GitHub.WikiPage");
          const context = {
            id: "Page",
            fqn: "Page",
            instanceId: "fixture",
            bindings: [],
            session: {
              emit: () => Effect.void,
              done: () => Effect.void,
              note: () => Effect.void,
            },
          };
          const created = yield* provider.reconcile({
            ...context,
            news: props,
            olds: undefined,
            output: undefined,
          });
          expect(
            yield* provider.read!({
              ...context,
              olds: props,
              output: undefined,
            }),
          ).toEqual(created);
          const adopted = yield* provider.reconcile({
            ...context,
            news: props,
            olds: undefined,
            output: created,
          });
          expect(adopted).toEqual(created);
          const news = { ...props, content: "Changed via provider" };
          const updated = yield* provider.reconcile({
            ...context,
            news,
            olds: props,
            output: adopted,
          });
          expect(updated.sha).not.toBe(created.sha);
          yield* provider.delete({
            ...context,
            olds: { ...news, allowDelete: undefined },
            output: updated,
          });
          expect(
            yield* provider.read!({
              ...context,
              olds: news,
              output: undefined,
            }),
          ).toEqual(updated);
          const renamed = { ...news, title: "Quick Start" };
          const replacement = yield* provider.reconcile({
            ...context,
            news: renamed,
            olds: undefined,
            output: undefined,
          });
          yield* provider.delete({ ...context, olds: news, output: updated });
          expect(
            yield* provider.read!({
              ...context,
              olds: news,
              output: undefined,
            }),
          ).toBeUndefined();
          expect(
            yield* provider.read!({
              ...context,
              olds: renamed,
              output: undefined,
            }),
          ).toEqual(replacement);
          yield* provider.delete({
            ...context,
            olds: renamed,
            output: replacement,
          });
          yield* provider.delete({
            ...context,
            olds: renamed,
            output: replacement,
          });
        }).pipe(
          Effect.provide(WikiPageProvider()),
          Effect.provide(fromToken(token)),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            localTransport,
          ),
        );
      }).pipe(Effect.scoped),
  );
  it.effect(
    "creates, recovers, updates, avoids no-op commits, and deletes idempotently",
    () =>
      Effect.gen(function* () {
        const { directory, repository } = yield* gitFixture;
        expect(yield* readWikiPage(repository, props)).toBeUndefined();
        const created = yield* syncWikiPage(repository, props);
        expect(created.pageName).toBe("Getting-Started");
        expect(created.htmlUrl).toBe(`${repository.htmlUrl}/Getting-Started`);
        expect(yield* readWikiPage(repository, props)).toEqual(created);
        expect(yield* syncWikiPage(repository, props)).toEqual(created);
        const updated = yield* syncWikiPage(repository, {
          ...props,
          content: "\n    Updated\n      indented\n",
          message: "Update fixture page",
        });
        expect(updated.sha).not.toBe(created.sha);
        expect(
          (yield* fixtureGit(
            directory,
            "--git-dir",
            repository.remote,
            "log",
            "-1",
            "--format=%s",
          )).trim(),
        ).toBe("Update fixture page");
        expect(
          yield* fixtureGit(
            directory,
            "--git-dir",
            repository.remote,
            "show",
            "HEAD:Getting-Started.md",
          ),
        ).toBe("Updated\n  indented");
        yield* deleteWikiPage(repository, props);
        yield* deleteWikiPage(repository, props);
        expect(yield* readWikiPage(repository, props)).toBeUndefined();
        expect(
          yield* fixtureGit(
            directory,
            "--git-dir",
            repository.remote,
            "show",
            "HEAD:Bootstrap.md",
          ),
        ).toBe("Unmanaged bootstrap page");
        expect(
          (yield* fixtureGit(
            directory,
            "--git-dir",
            repository.remote,
            "rev-list",
            "--count",
            "HEAD",
          )).trim(),
        ).toBe("4");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "preserves by default and recreates an externally deleted page",
    () =>
      Effect.gen(function* () {
        const { repository } = yield* gitFixture;
        const created = yield* syncWikiPage(repository, props);
        yield* deleteWikiPage(repository, { ...props, allowDelete: undefined });
        expect(yield* readWikiPage(repository, props)).toEqual(created);
        yield* deleteWikiPage(repository, props);
        const recreated = yield* syncWikiPage(repository, props);
        expect(recreated.sha).not.toBe(created.sha);
        expect(yield* readWikiPage(repository, props)).toEqual(recreated);
        yield* deleteWikiPage(repository, props);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "converges all formats, removes previous extensions, and preserves unrelated pages",
    () =>
      Effect.gen(function* () {
        const { directory, repository } = yield* gitFixture;
        const formats = {
          markdown: "md",
          asciidoc: "asciidoc",
          mediawiki: "mediawiki",
          org: "org",
          pod: "pod",
          rdoc: "rdoc",
          rest: "rst",
          textile: "textile",
        } as const;
        for (const format of Object.keys(formats) as Array<
          keyof typeof formats
        >) {
          const next = { ...props, format };
          const page = yield* syncWikiPage(repository, next);
          expect(yield* readWikiPage(repository, props)).toEqual(page);
          expect(
            (yield* fixtureGit(
              directory,
              "--git-dir",
              repository.remote,
              "ls-tree",
              "--name-only",
              "HEAD",
            ))
              .trim()
              .split("\n"),
          ).toEqual(["Bootstrap.md", `Getting-Started.${formats[format]}`]);
        }
        yield* deleteWikiPage(repository, props);
        expect(yield* readWikiPage(repository, props)).toBeUndefined();
      }).pipe(Effect.scoped),
  );

  it.effect(
    "recovers alternate extensions and safely replaces symlink pages",
    () =>
      Effect.gen(function* () {
        const { fs, path, directory, seed, repository } = yield* gitFixture;
        yield* fs.writeFileString(
          path.join(seed, "Getting-Started.markdown"),
          "Existing page",
        );
        const outside = path.join(directory, "outside");
        yield* fs.writeFileString(outside, "Do not overwrite");
        yield* fs.symlink(outside, path.join(seed, "Linked.md"));
        yield* fixtureGit(seed, "add", ".");
        yield* fixtureGit(seed, "commit", "-m", "External pages");
        yield* fixtureGit(seed, "push", "origin", "HEAD");
        expect(yield* readWikiPage(repository, props)).toBeDefined();
        yield* syncWikiPage(repository, props);
        yield* syncWikiPage(repository, { ...props, title: "Linked" });
        expect(yield* fs.readFileString(outside)).toBe("Do not overwrite");
        expect(
          (yield* fixtureGit(
            directory,
            "--git-dir",
            repository.remote,
            "ls-tree",
            "HEAD",
            "Linked.md",
          )).startsWith("100644"),
        ).toBe(true);
        expect(
          (yield* fixtureGit(
            directory,
            "--git-dir",
            repository.remote,
            "ls-tree",
            "--name-only",
            "HEAD",
          )).includes("Getting-Started.markdown"),
        ).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect("retries concurrent pushes without losing sibling pages", () =>
    Effect.gen(function* () {
      const { repository } = yield* gitFixture;
      const titles = ["First", "Second", "Third"];
      yield* Effect.all(
        titles.map((title) => syncWikiPage(repository, { ...props, title })),
        { concurrency: 3 },
      );
      for (const title of titles)
        expect(
          yield* readWikiPage(repository, { ...props, title }),
        ).toBeDefined();
    }).pipe(Effect.scoped),
  );

  it.effect(
    "reports unavailable repositories with actionable errors without skipping lifecycle work",
    () =>
      Effect.gen(function* () {
        const { directory, path, repository } = yield* gitFixture;
        const missing = {
          ...repository,
          remote: path.join(directory, "uninitialized.wiki.git"),
        };
        const result = yield* Effect.result(syncWikiPage(missing, props));
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("WikiRepositoryUnavailable");
          expect(result.failure.message).toContain(
            "first page in the GitHub web UI",
          );
          expect(result.failure.message).not.toContain(token);
        }
        expect(yield* readWikiPage(missing, props)).toBeUndefined();
        yield* deleteWikiPage(missing, props);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps credentials out of arguments and config and removes temporary checkouts",
    () =>
      Effect.gen(function* () {
        const { fs, repository } = yield* gitFixture;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const directories = new Set<string>();
        const safeSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (command._tag === "StandardCommand") {
              expect(command.args.join(" ")).not.toContain(token);
              expect(command.options.extendEnv).toBe(false);
              const env = command.options.env!;
              expect(env.GIT_CONFIG_KEY_0).toBe(
                `http.${repository.remote}.extraHeader`,
              );
              expect(env.GIT_CONFIG_VALUE_0).toMatch(/^Authorization: Basic /);
              expect(env.GIT_TRACE).toBeUndefined();
              directories.add(env.HOME!);
              expect(yield* fs.readFileString(env.GIT_CONFIG_GLOBAL!)).toBe("");
            }
            return yield* spawner.spawn(command);
          }),
        );
        yield* syncWikiPage(repository, props).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            safeSpawner,
          ),
        );
        expect(directories.size).toBe(1);
        for (const directory of directories)
          expect(yield* fs.exists(directory)).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect("rejects unsafe titles and produces encoded browser URLs", () =>
    Effect.gen(function* () {
      const { repository } = yield* gitFixture;
      for (const title of [
        "../escape",
        "a/b",
        "a\\b",
        "",
        "..",
        " line",
        "line\nbreak",
      ]) {
        const result = yield* Effect.result(
          syncWikiPage(repository, { ...props, title }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure._tag).toBe("InvalidWikiPage");
      }
      const page = yield* syncWikiPage(repository, {
        ...props,
        title: "API #1?",
      });
      expect(page.htmlUrl).toBe(`${repository.htmlUrl}/API-%231%3F`);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "maps public, enterprise, and data-residency API hosts to Git hosts",
    () =>
      Effect.gen(function* () {
        const cases = [
          [undefined, "https://enterprise.example.com"],
          ["github.com", "https://github.com"],
          [
            "https://wiki.example.com:8443/api/v3",
            "https://wiki.example.com:8443",
          ],
          ["https://api.acme.ghe.com", "https://acme.ghe.com"],
        ] as const;
        for (const [baseUrl, origin] of cases) {
          const repository = yield* wikiRepository({ ...props, baseUrl });
          expect(repository.remote).toBe(
            `${origin}/${props.owner}/${props.repository}.wiki.git`,
          );
          expect(repository.htmlUrl).toBe(
            `${origin}/${props.owner}/${props.repository}/wiki`,
          );
        }
        const insecure = yield* Effect.result(
          wikiRepository({ ...props, baseUrl: "http://wiki.example.com" }),
        );
        expect(Result.isFailure(insecure)).toBe(true);
      }).pipe(
        Effect.provide(fromToken(token, { baseUrl: "enterprise.example.com" })),
      ),
  );

  it.effect(
    "replaces title, repository, owner, and host changes but updates formats in place",
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.Provider<WikiPage>("GitHub.WikiPage");
        const diff = (news: WikiPageProps) =>
          provider.diff!({
            id: "Page",
            fqn: "Page",
            instanceId: "fixture",
            olds: props,
            news,
            oldBindings: [],
            newBindings: [],
            output: undefined,
          });
        for (const news of [
          { ...props, title: "Renamed" },
          { ...props, repository: "other" },
          { ...props, owner: "alchemy-run-test-2" },
          { ...props, baseUrl: "enterprise.example.com" },
        ])
          expect(yield* diff(news)).toEqual({ action: "replace" });
        expect(yield* diff({ ...props, format: "asciidoc" })).toBeUndefined();
        expect(
          yield* diff({ ...props, title: "Getting-Started" }),
        ).toBeUndefined();
        expect(
          yield* diff({ ...props, baseUrl: "https://api.github.com" }),
        ).toBeUndefined();
      }).pipe(
        Effect.provide(WikiPageProvider()),
        Effect.provide(fromToken(token)),
      ),
  );
});
