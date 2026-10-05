/**
 * changelogithub's `generate()`, minus the 1 MB ceiling.
 *
 * Upstream reads the commit range with `execSync`, whose default `maxBuffer`
 * is 1 MB. `git log … --name-status` prints every changed path of every
 * commit in the range, so a release spanning a large diff blows past that and
 * the process is killed:
 *
 *   error: spawnSync /bin/sh ENOBUFS (stdout or stderr buffer reached
 *   maxBuffer size limit)
 *
 * It is not a pathological case — one repo-wide refactor in the range is
 * enough, and the release then fails at the tagging step having already
 * bumped versions.
 *
 * `generate()` is `getGitDiff → parseCommits → resolveAuthors → markdown`,
 * and changelogithub exports every piece except the first. So this reads the
 * log itself, streaming, and hands the result to the same parser — no
 * reimplementation of the changelog format, and no fork.
 */
import type { ChangelogOptions, Commit } from "changelogithub";
import {
  generateMarkdown,
  parseCommits,
  resolveAuthors,
  resolveConfig,
} from "changelogithub";

interface RawGitCommit {
  message: string;
  body: string;
  shortHash: string;
  author: { name: string; email: string };
}

/**
 * The same command and parsing as changelogen's `getGitDiff`, read through a
 * pipe instead of a fixed buffer. Kept byte-compatible with upstream: the
 * `----` record separator and `|`-delimited header are what `parseCommits`
 * expects.
 */
export const getGitDiff = async (
  from: string | undefined,
  to = "HEAD",
): Promise<RawGitCommit[]> => {
  const proc = Bun.spawn(
    [
      "git",
      "--no-pager",
      "log",
      `${from ? `${from}...` : ""}${to}`,
      "--pretty=----%n%s|%h|%an|%ae%n%b",
      "--name-status",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [raw, err, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git log ${from ?? ""}...${to} failed: ${err.trim()}`);
  }
  return raw
    .trim()
    .split("----\n")
    .splice(1)
    .map((line) => {
      const [firstLine, ..._body] = line.split("\n");
      const [message, shortHash, authorName, authorEmail] = (
        firstLine ?? ""
      ).split("|");
      return {
        message: message ?? "",
        shortHash: shortHash ?? "",
        author: { name: authorName ?? "", email: authorEmail ?? "" },
        body: _body.join("\n"),
      };
    });
};

/** Drop-in for changelogithub's `generate`. */
export const generate = async (options: ChangelogOptions) => {
  const config = await resolveConfig(options);
  const commits: Commit[] = parseCommits(
    (await getGitDiff(config.from, config.to)) as never,
    config,
  );
  if (config.contributors) await resolveAuthors(commits, config);
  return { config, commits, md: generateMarkdown(commits, config) };
};
