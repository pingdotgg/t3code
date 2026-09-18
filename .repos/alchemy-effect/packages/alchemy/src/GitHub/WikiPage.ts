import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { isResolved } from "../Diff.ts";
import { dedent } from "../Util/dedent.ts";
import { exec } from "../Util/exec.ts";
import { GitHubCredentials } from "./Credentials.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { effectiveGitHubBaseUrl, gitHubBaseUrlChanged } from "./Octokit.ts";
import type * as GitHub from "./Providers.ts";

export interface WikiPageProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Page title (e.g. `Home`, `Getting Started`). Whitespace becomes hyphens
   * in the page name. Changing that name replaces the page (creates a new
   * page and deletes the old one if opted in via `allowDelete`).
   */
  title: string;

  /**
   * Page content (supports GitHub Markdown, AsciiDoc, MediaWiki, and more
   * depending on the file extension derived from `format`).
   *
   * The content is automatically dedented, so you can use indented template
   * literals without worrying about leading whitespace. Accepts
   * `Output<string>` at the call site via `Output.interpolate` to embed
   * resource attributes that are not yet resolved.
   */
  content: string;

  /**
   * Commit message for creating or updating the page.
   * @default "Update {title}"
   */
  message?: string;

  /**
   * Page format/markup language. The format is appended to the page name as
   * an extension (e.g. `markdown` → `Page.md`, `asciidoc` → `Page.asciidoc`).
   * @default "markdown"
   */
  format?:
    | "markdown"
    | "asciidoc"
    | "mediawiki"
    | "org"
    | "pod"
    | "rdoc"
    | "rest"
    | "textile";

  /**
   * Whether to allow deletion of the page when the resource is destroyed.
   * By default, wiki pages are never deleted to preserve documentation history.
   * @default false
   */
  allowDelete?: boolean;

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same name on a
   * different GitHub instance is a different physical resource. Authenticated
   * wiki Git operations require HTTPS.
   */
  baseUrl?: string;
}

export interface WikiPage extends Resource<
  "GitHub.WikiPage",
  WikiPageProps,
  {
    /**
     * The page title.
     */
    title: string;

    /**
     * The page name in URL form (e.g. `Home`, `Getting-Started`).
     */
    pageName: string;

    /**
     * URL to view the page in a browser.
     */
    htmlUrl: string;

    /**
     * SHA hash of the current page revision.
     */
    sha: string;
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub wiki page.
 *
 * `WikiPage` manages the lifecycle of a page in a repository's wiki. Wiki
 * pages are created on first deploy and updated in place on subsequent
 * deploys when the `content` changes. By default, pages are never deleted to
 * preserve documentation history — set `allowDelete: true` to opt in.
 *
 * The repository's wiki must be enabled (`hasWiki: true` on the Repository
 * resource) and initialized by creating its first page in the GitHub web UI.
 * Enabling the wiki or setting `autoInit` on the repository does not initialize
 * the separate wiki Git repository. An inaccessible or uninitialized wiki
 * produces `WikiRepositoryUnavailable` with setup instructions.
 *
 * Git must be installed on the deployment machine. Pages are managed through
 * the wiki's Git repository, not the GitHub REST API. Each content or format
 * change creates a commit; unchanged pages do not. Concurrent pushes are
 * retried against a fresh checkout without force-pushing. Deletion removes the
 * current page file, not its Git history. Authentication uses a transient
 * process-environment header; tokens are not stored in clone URLs or Git config.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied by
 * `GitHub.providers()` (env, stored PAT, `gh` CLI, or OAuth). The token needs
 * `repo` scope for private repositories or `public_repo` for public ones.
 * ### Creating Wiki Pages
 * **Example:** Basic Wiki Page
 * ```typescript
 * const home = yield* GitHub.WikiPage("home", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Home",
 *   content: "Welcome to the wiki!",
 * });
 * ```
 *
 * **Example:** Formatted Wiki Page
 * ```typescript
 * yield* GitHub.WikiPage("getting-started", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Getting Started",
 *   content: `
 *     # Getting Started
 *
 *     Install the package:
 *
 *     \`\`\`bash
 *     npm install my-package
 *     \`\`\`
 *   `,
 *   format: "markdown",
 *   message: "Add getting started guide",
 * });
 * ```
 *
 * ### Updating Wiki Pages
 * Deploy with the same logical ID and a different `content` to update the
 * existing page in place rather than creating a new one.
 *
 * **Example:** Update Page Content
 * ```typescript
 * yield* GitHub.WikiPage("api-docs", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "API Documentation",
 *   content: "Updated API documentation content",
 * });
 * ```
 *
 * ### Alternative Formats
 * **Example:** AsciiDoc Page
 * ```typescript
 * yield* GitHub.WikiPage("architecture", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Architecture",
 *   content: `
 *     = System Architecture
 *
 *     == Overview
 *
 *     The system is built with...
 *   `,
 *   format: "asciidoc",
 * });
 * ```
 *
 * ### Deleting Wiki Pages
 * **Example:** Allow Page Deletion
 * ```typescript
 * const temp = yield* GitHub.WikiPage("temp-page", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Temporary Page",
 *   content: "This page can be deleted",
 *   allowDelete: true,
 * });
 * ```
 *
 * ### Wiring with Other Resources
 * **Example:** Create Wiki Pages for a Repository
 * Deploy the repository first and create its first wiki page in the GitHub
 * web UI before adding `WikiPage` to the stack.
 * ```typescript
 * import * as Output from "alchemy/Output";
 *
 * const repo = yield* GitHub.Repository("docs", {
 *   owner: "my-org",
 *   name: "docs",
 *   hasWiki: true,
 *   autoInit: true,
 * });
 *
 * yield* GitHub.WikiPage("home", {
 *   owner: repo.owner!,
 *   repository: Output.map(repo.fullName, (fullName) => fullName.split("/")[1]!),
 *   title: "Home",
 *   content: "Welcome to the documentation wiki!",
 * });
 * ```
 *
 * @resource
 */
export const WikiPage = Resource<WikiPage>("GitHub.WikiPage");

export class WikiRepositoryUnavailable extends Data.TaggedError(
  "WikiRepositoryUnavailable",
)<{ readonly message: string }> {}

export class WikiGitError extends Data.TaggedError("WikiGitError")<{
  readonly operation: string;
  readonly reason: "missing" | "conflict" | "command";
  readonly message: string;
}> {}

export class InvalidWikiPage extends Data.TaggedError("InvalidWikiPage")<{
  readonly message: string;
}> {}

const extensions = {
  markdown: ["md", "markdown", "mdown", "mkdn", "mkd"],
  asciidoc: ["asciidoc", "adoc", "asc"],
  mediawiki: ["mediawiki", "wiki"],
  org: ["org"],
  pod: ["pod"],
  rdoc: ["rdoc"],
  rest: ["rst", "rest"],
  textile: ["textile"],
} as const;

export interface WikiRepository {
  readonly remote: string;
  readonly htmlUrl: string;
  readonly token: Redacted.Redacted<string>;
}

const pageNameFor = (title: string) =>
  Effect.gen(function* () {
    if (
      title.trim() !== title ||
      title.length === 0 ||
      /[\x00-\x1f\x7f/\\]/.test(title) ||
      title === "." ||
      title === ".."
    ) {
      return yield* new InvalidWikiPage({
        message:
          "Wiki page titles must be nonempty, trimmed names without path separators or control characters.",
      });
    }
    return title.replace(/\s+/g, "-");
  });

export const wikiRepository = Effect.fn(function* (props: WikiPageProps) {
  yield* pageNameFor(props.title);
  if (
    ![props.owner, props.repository].every(
      (part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..",
    )
  ) {
    return yield* new InvalidWikiPage({
      message:
        "Wiki owner and repository must be GitHub names, not paths or URLs.",
    });
  }
  const baseUrl = yield* effectiveGitHubBaseUrl(props.baseUrl);
  const origin = yield* Effect.sync(() => {
    const url = new URL(baseUrl ?? "https://github.com");
    if (url.hostname.startsWith("api.") && url.hostname.endsWith(".ghe.com")) {
      url.hostname = url.hostname.slice(4);
    }
    return url.origin;
  });
  if (!origin.startsWith("https://")) {
    return yield* new InvalidWikiPage({
      message: "Wiki Git authentication requires an HTTPS GitHub host.",
    });
  }
  const credentials = yield* yield* GitHubCredentials;
  const repositoryUrl = `${origin}/${props.owner}/${props.repository}`;
  return {
    remote: `${repositoryUrl}.wiki.git`,
    htmlUrl: `${repositoryUrl}/wiki`,
    token: credentials.token,
  } satisfies WikiRepository;
});

// Only the transient process environment contains the authorization header.
const gitEnvironment = Effect.fn(function* (
  repository: WikiRepository,
  directory: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const config = path.join(directory, "gitconfig");
  yield* fs.writeFileString(config, "");
  return yield* Effect.sync(() => ({
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: directory,
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${repository.remote}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${Redacted.value(repository.token)}`).toString("base64")}`,
    GIT_AUTHOR_NAME: "Alchemy",
    GIT_AUTHOR_EMAIL: "alchemy@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Alchemy",
    GIT_COMMITTER_EMAIL: "alchemy@users.noreply.github.com",
  }));
});

const git = Effect.fn(
  function* (
    directory: string,
    env: Record<string, string | undefined>,
    ...args: string[]
  ) {
    const operation = args[0]!;
    const result = yield* exec(
      ChildProcess.make(
        "git",
        [
          "--literal-pathspecs",
          "-c",
          "credential.helper=",
          "-c",
          "commit.gpgSign=false",
          "-c",
          "http.followRedirects=false",
          ...args,
        ],
        { cwd: directory, env, extendEnv: false },
      ),
    ).pipe(
      Effect.mapError(
        () =>
          new WikiGitError({
            operation,
            reason: "command",
            message: `Unable to run git ${operation}. Ensure Git is installed and executable.`,
          }),
      ),
    );
    if (result.exitCode !== 0) {
      const reason =
        /Repository not found|repository '.+' (?:not found|does not exist)|does not appear to be a git repository/i.test(
          result.stderr,
        )
          ? "missing"
          : operation === "push" &&
              /\[rejected\]|cannot lock ref|failed to update ref/i.test(
                result.stderr,
              )
            ? "conflict"
            : "command";
      // Git diagnostics can include server-controlled text or credentials.
      return yield* new WikiGitError({
        operation,
        reason,
        message: `git ${operation} failed (exit ${result.exitCode}). Check repository access and GitHub token permissions.`,
      });
    }
    return result.stdout;
  },
  Effect.scoped,
  Effect.timeout("20 seconds"),
);

const checkout = Effect.fn(function* (repository: WikiRepository) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "alchemy-wiki-",
  });
  const env = yield* gitEnvironment(repository, directory);
  yield* git(
    directory,
    env,
    "clone",
    "--quiet",
    "--",
    repository.remote,
    "wiki",
  ).pipe(
    Effect.catchTag("WikiGitError", (error) =>
      Effect.fail(
        error.reason === "missing"
          ? new WikiRepositoryUnavailable({
              message: `Cannot access ${repository.htmlUrl}. Enable the repository wiki and create its first page in the GitHub web UI before deploying WikiPage. Git cannot initialize a GitHub wiki that has never had a page. If it is already initialized, verify the repository name and token's repository access.`,
            })
          : error,
      ),
    ),
  );
  const cwd = path.join(directory, "wiki");
  const run = (...args: string[]) => git(cwd, env, ...args);
  const files = (yield* run("ls-files", "-z")).split("\0").filter(Boolean);
  return { cwd, run, files };
});

type Checkout = Effect.Success<ReturnType<typeof checkout>>;

const pageFiles = (files: string[], pageName: string) =>
  Object.values(extensions)
    .flatMap((formats) =>
      formats.map((extension) => `${pageName}.${extension}`),
    )
    .filter((file) => files.includes(file));

const attributes = Effect.fn(function* (
  repository: WikiRepository,
  props: WikiPageProps,
  wiki: Checkout,
  file: string,
) {
  return {
    title: props.title,
    pageName: props.title.replace(/\s+/g, "-"),
    htmlUrl: `${repository.htmlUrl}/${encodeURIComponent(props.title.replace(/\s+/g, "-"))}`,
    sha: (yield* wiki.run("log", "-1", "--format=%H", "--", file)).trim(),
  } satisfies WikiPage["Attributes"];
});

export const readWikiPage = Effect.fn(
  function* (repository: WikiRepository, props: WikiPageProps) {
    const pageName = yield* pageNameFor(props.title);
    const wiki = yield* checkout(repository);
    const files = pageFiles(wiki.files, pageName);
    const desired = `${pageName}.${extensions[props.format ?? "markdown"][0]}`;
    const file = files.includes(desired) ? desired : files[0];
    return file === undefined
      ? undefined
      : yield* attributes(repository, props, wiki, file);
  },
  Effect.scoped,
  (effect) =>
    effect.pipe(
      Effect.catchTag("WikiRepositoryUnavailable", () =>
        Effect.succeed(undefined),
      ),
    ),
);

const retryConcurrentPush = <A, E, R>(
  effect: Effect.Effect<A, E | WikiGitError, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) =>
        error instanceof WikiGitError && error.reason === "conflict",
      schedule: Schedule.spaced("200 millis"),
      times: 3,
    }),
    Effect.timeout("60 seconds"),
  );

export const syncWikiPage = Effect.fn(
  function* (repository: WikiRepository, props: WikiPageProps) {
    const pageName = yield* pageNameFor(props.title);
    const wiki = yield* checkout(repository);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files = pageFiles(wiki.files, pageName);
    const file = `${pageName}.${extensions[props.format ?? "markdown"][0]}`;
    const content = dedent(props.content);
    const observed = wiki.files.includes(file)
      ? yield* wiki.run("show", `HEAD:${file}`)
      : undefined;
    const mode = wiki.files.includes(file)
      ? yield* wiki.run("ls-files", "--stage", "--", file)
      : "";
    if (
      observed !== content ||
      files.some((existing) => existing !== file) ||
      mode.startsWith("120000")
    ) {
      if (files.length > 0) yield* wiki.run("rm", "--", ...files);
      yield* fs.writeFileString(path.join(wiki.cwd, file), content);
      yield* wiki.run("add", "--", file);
      yield* wiki.run(
        "commit",
        "--quiet",
        "-m",
        props.message ?? `Update ${props.title}`,
      );
      yield* wiki.run("push", "--quiet", "origin", "HEAD");
    }
    return yield* attributes(repository, props, wiki, file);
  },
  Effect.scoped,
  retryConcurrentPush,
);

export const deleteWikiPage = Effect.fn(
  function* (repository: WikiRepository, props: WikiPageProps) {
    if (!props.allowDelete) return;
    const pageName = yield* pageNameFor(props.title);
    const wiki = yield* checkout(repository);
    const files = pageFiles(wiki.files, pageName);
    if (files.length === 0) return;
    yield* wiki.run("rm", "--", ...files);
    yield* wiki.run("commit", "--quiet", "-m", `Delete ${props.title}`);
    yield* wiki.run("push", "--quiet", "origin", "HEAD");
  },
  Effect.scoped,
  retryConcurrentPush,
  (effect) =>
    effect.pipe(
      Effect.catchTag("WikiRepositoryUnavailable", () => Effect.void),
    ),
);

export const WikiPageProvider = () =>
  Provider.succeed(WikiPage, {
    stables: ["pageName"],

    // Wiki pages have no account-wide enumeration API.
    list: () => Effect.succeed([]),

    // Replacement must not delete the successor when titles normalize identically.
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return;
      if (olds === undefined) return;
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        news.title.replace(/\s+/g, "-") !== olds.title.replace(/\s+/g, "-") ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" };
      }
    }),

    read: Effect.fn(function* ({ olds }) {
      return yield* readWikiPage(yield* wikiRepository(olds), olds);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      return yield* syncWikiPage(yield* wikiRepository(news), news);
    }),

    delete: Effect.fn(function* ({ olds }) {
      if (!olds.allowDelete) return;
      yield* deleteWikiPage(yield* wikiRepository(olds), olds);
    }),
  });
