// Registry differential check: T3's host definition registry and ours answer the same cases,
// and every answer must be equal.
//
//   CONN_MONOREPO=<conn checkout> node crates/conn-source-control/tools/registry-diff.mjs <examples/registry_cases binary>
//
// T3's side is `builtInSourceControlDefinitions` (packages/source-control-definitions) and
// `makeThreadPullRequests` bound to it, loaded from the monorepo. Ours is
// `examples/registry_cases.rs`. The inputs are every string literal in T3's own definition
// tests (so a new upstream case is tried at once) plus a fixed grid of hosts, paths, remotes
// and identities. Nothing is called over the network.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import { importSource, inMonorepo } from "../../../tools/monorepo.mjs";

const [binary] = process.argv.slice(2);
if (!binary) throw new Error("usage: registry-diff.mjs <examples/registry_cases binary>");

const { builtInSourceControlDefinitions: registry, canonicalizeGitCafePullRequestUrl } =
  await importSource("packages/source-control-definitions/src/registry.ts");
const { makeThreadPullRequests } = await importSource(
  "packages/source-control-core/src/shared/threadPullRequests.ts",
);
const threadKeys = makeThreadPullRequests(registry);

// ---- Inputs ------------------------------------------------------------------------------

const TEST_FILES = [
  "github",
  "gitlab",
  "gitcafe",
  "forgejo",
  "bitbucket",
  "azure-devops",
  "cursor-origin",
].map((host) => `packages/source-control-${host}/src/shared/definition.test.ts`);

/** Every quoted literal in T3's definition tests that could be a URL, remote or key. */
function harvested() {
  const out = new Set();
  for (const file of TEST_FILES) {
    const path = inMonorepo(file);
    if (!NodeFS.existsSync(path)) continue;
    const source = NodeFS.readFileSync(path, "utf8");
    for (const match of source.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`$\\\n]*)`/g)) {
      const text = match[1] ?? match[2] ?? match[3];
      if (text && text.length < 300 && /[/:@]/.test(text)) out.add(text);
    }
  }
  return [...out];
}

const HOSTS = [
  "github.com",
  "GitHub.com",
  "ghe.example",
  "acme.ghe.com",
  "github.acme.com:8443",
  "gitlab.com",
  "gitlab.example.com",
  "git.cafe",
  "staging.git.cafe",
  "origin.cursor.com",
  "cursor.com",
  "www.cursor.com",
  "codeberg.org",
  "gitea.github.example",
  "forgejo.example:3000",
  "bitbucket.org",
  "team.bitbucket.org",
  "dev.azure.com",
  "ssh.dev.azure.com",
  "org.visualstudio.com",
  "vs-ssh.visualstudio.com",
  "example.com",
  "[::1]:8080",
  "127.0.0.1",
  "xn--bcher-kva.example",
  "bücher.example",
  "HOST.Example:443",
];
const PATHS = [
  "/o/r/pull/12",
  "/O/R/pull/12/files?tab=1#x",
  "/o/r/pulls/12",
  "/g/s/p/-/merge_requests/3",
  "/a/b/-/merge_requests/1/-/merge_requests/2",
  "/o/p/_git/r/pullrequest/4",
  "/col/o/p/_git/r/pullrequest/4/",
  "/codebase/o/r/pull/5",
  "/w/r/pull-requests/6",
  "/o/r/pull/0",
  "/o/r/pull/012",
  "/o/r/pull/9007199254740993",
  "//o/r/pull/1",
  "/o%2Fx/r/pull/1",
  "/o/r/pull/1abc",
  "/mount/o/r/pulls/9",
];
const SCHEMES = ["https", "http", "ssh", "git", "ftp"];
const urls = [];
for (const scheme of SCHEMES)
  for (const host of HOSTS) for (const path of PATHS) urls.push(`${scheme}://${host}${path}`);

const remotes = [];
for (const host of HOSTS) {
  const bare = host.replace(/:\d+$/u, "");
  remotes.push(
    `git@${bare}:o/r.git`,
    `${bare}:o/r`,
    `ssh://git@${host}/o/r.git`,
    `https://${host}/o/r.git`,
    `https://user:pw@${host}/g/s/p.git/`,
    `  http://${host}/O/R  `,
    `git://${host}/o/r`,
    `git@${bare}:v3/org/proj/repo`,
  );
}
remotes.push("file:///srv/r.git", "/srv/r.git", "C:\\repos\\r", "c:/repos/r", "", "   ", "x::y/z");

const KINDS = registry.definitions.map((definition) => definition.kind);

const identities = [];
for (const remote of [
  "git@github.com:o/r.git",
  "https://forgejo.example:3000/mount/o/r.git",
  "http://gitea.example/o/r",
  "git@ssh.dev.azure.com:v3/org/proj/repo",
  "https://org.visualstudio.com/DefaultCollection/proj/_git/repo",
  "",
]) {
  for (const webUrl of [undefined, "https://forgejo.example:3000/mount/o/r", "not a url"]) {
    for (const displayName of [undefined, "o/r", "org/proj/_git/my%20repo", "mount/o/r"]) {
      const key = remote ? registry.repositoryKeyFromRemote(remote) : "";
      identities.push({
        canonicalKey: key,
        locator: { remoteUrl: remote },
        ...(webUrl === undefined ? {} : { webUrl }),
        ...(displayName === undefined ? {} : { displayName }),
        owner: "o",
        name: displayName?.endsWith("repo") ? undefined : "r",
      });
    }
  }
}

const links = [
  { host: "github.com", repository: "o/r", number: 3 },
  { host: "forgejo.example", repository: "mount/o/r", number: 3, authority: "forgejo.example:3000" },
  { host: "forgejo.example", repository: "o/r", number: 3, authority: "forgejo.example:3001" },
  { host: "gitea.example", repository: "o/r", number: 1 },
  { host: "dev.azure.com", repository: "org/proj/_git/repo", number: 9 },
  { host: "ssh.dev.azure.com", repository: "v3/org/proj/repo", number: 9 },
];

// ---- Cases -------------------------------------------------------------------------------

const literals = harvested();
const cases = [];
for (const value of [...literals, ...urls]) {
  cases.push({ op: "parseChangeRequestUrl", url: value });
  cases.push({ op: "canonicalizeGitCafe", url: value });
}
for (const value of [...literals, ...remotes]) {
  cases.push({ op: "recognizeRemote", remote: value });
  cases.push({ op: "repositoryKeyFromRemote", remote: value });
}
for (const value of [...literals, ...remotes.map((r) => registry.repositoryKeyFromRemote(r))]) {
  cases.push({ op: "canonicalRepositoryKey", key: value });
  cases.push({ op: "findByRepositoryKey", key: value });
}
for (let i = 0; i + 1 < urls.length; i += 7) {
  cases.push({ op: "isSameChangeRequest", left: urls[i], right: urls[i + 1] });
  cases.push({ op: "isSameChangeRequest", left: urls[i], right: urls[i].toUpperCase() });
}
for (const kind of KINDS) {
  for (const host of ["github.com", "gitlab.example.com", "forgejo.example:3000", "ssh.dev.azure.com", "git.cafe"]) {
    for (const repository of ["o/r", "g/s/p", "v3/org/proj/repo", "o/../x", "O/R"]) {
      for (const remoteUrl of [undefined, `http://${host}/${repository}.git`, `git@${host}:o/r`]) {
        for (const webUrl of [undefined, "", "https://forge.example/mount/o/r//"]) {
          for (const number of [1, 12, 0]) {
            const input = { host, repository, number };
            if (remoteUrl !== undefined) input.remoteUrl = remoteUrl;
            if (webUrl !== undefined) input.webUrl = webUrl;
            cases.push({ op: "changeRequestUrl", kind, input });
          }
        }
      }
    }
  }
  for (const number of [1, 42]) cases.push({ op: "changeRequestHeadRef", kind, number });
  for (const identity of identities) {
    cases.push({ op: "checkoutChangeRequestHost", kind, identity });
    cases.push({ op: "changeRequestHost", kind, identity });
    cases.push({ op: "repositorySelector", identity: { ...identity, provider: kind } });
    for (const link of links) {
      cases.push({ op: "isChangeRequestInRepository", kind, identity, link });
      cases.push({ op: "canReadChangeRequestOnHost", kind, identity, link });
    }
  }
}
for (const identity of identities) {
  cases.push({ op: "repositorySelector", identity });
  cases.push({ op: "changeRequestHost", identity, kind: "unknown" });
}
for (const value of [...literals, ...urls.slice(0, 400)]) {
  const parsed = registry.parseChangeRequestUrl(value)?.link;
  for (const number of [parsed?.number ?? 1, 99]) {
    cases.push({ op: "normalizeThreadKey", key: { host: "Example.com", repository: " O/R ", number, url: value } });
    if (parsed) cases.push({ op: "normalizeThreadKey", key: { ...parsed, number } });
    cases.push({ op: "legacyThreadKey", linked: { repository: "O/R", number, url: value } });
    cases.push({ op: "legacyThreadKey", linked: { repository: "O/R", number, url: value }, fallbackHost: " Fallback " });
  }
}

// ---- T3's answers ------------------------------------------------------------------------

const definition = (kind) => registry.find(kind);
function t3(c) {
  switch (c.op) {
    case "recognizeRemote":
      return registry.recognizeRemote(c.remote);
    case "parseChangeRequestUrl": {
      const parsed = registry.parseChangeRequestUrl(c.url);
      return parsed === null ? null : { kind: parsed.definition.kind, link: parsed.link };
    }
    case "changeRequestUrl":
      return definition(c.kind).changeRequestUrl(c.input);
    case "canonicalRepositoryKey":
      return registry.canonicalRepositoryKey(c.key);
    case "findByRepositoryKey":
      return registry.findByRepositoryKey(c.key)?.kind ?? null;
    case "repositoryKeyFromRemote":
      return registry.repositoryKeyFromRemote(c.remote);
    case "repositorySelector":
      return registry.repositorySelector(c.identity);
    case "changeRequestHost":
      return registry.changeRequestHost(c.identity, c.kind) ?? null;
    case "isChangeRequestInRepository":
      return definition(c.kind).isChangeRequestInRepository(c.identity, c.link);
    case "canReadChangeRequestOnHost":
      return definition(c.kind).canReadChangeRequestOnHost(c.identity, c.link);
    case "checkoutChangeRequestHost":
      return definition(c.kind).checkoutChangeRequestHost(c.identity);
    case "changeRequestHeadRef":
      return definition(c.kind).changeRequestHeadRef?.(c.number) ?? null;
    case "isSameChangeRequest":
      return registry.isSameChangeRequest(c.left, c.right);
    case "canonicalizeGitCafe":
      return canonicalizeGitCafePullRequestUrl(c.url);
    case "normalizeThreadKey":
      return threadKeys.normalizeThreadPullRequestKey(c.key);
    case "legacyThreadKey":
      return threadKeys.legacyThreadPullRequestKey(c.linked, c.fallbackHost);
    default:
      throw new Error(`unknown op ${c.op}`);
  }
}

/** JSON with sorted keys and no `undefined`, so key order and absent keys compare equal. */
function canonical(value) {
  if (value === undefined) return "null";
  return JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, v[k]]))
      : v,
  );
}

const expected = cases.map((c) => {
  try {
    return canonical(t3(c));
  } catch (error) {
    return canonical({ threw: String(error?.message ?? error) });
  }
});

// ---- Ours --------------------------------------------------------------------------------

const ours = JSON.parse(
  NodeChildProcess.execFileSync(binary, [], {
    input: JSON.stringify(cases),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }),
).map(canonical);

let differences = 0;
const byOp = new Map();
for (let i = 0; i < cases.length; i += 1) {
  const op = cases[i].op;
  const entry = byOp.get(op) ?? { total: 0, differ: 0 };
  entry.total += 1;
  if (expected[i] !== ours[i]) {
    entry.differ += 1;
    differences += 1;
    if (differences <= 40) {
      console.log(`DIFF ${JSON.stringify(cases[i])}\n  t3:   ${expected[i]}\n  rust: ${ours[i]}`);
    }
  }
  byOp.set(op, entry);
}
for (const [op, { total, differ }] of byOp) console.log(`${differ === 0 ? "same" : "DIFF"} ${op}: ${total - differ} of ${total}`);
console.log(`${cases.length} cases (${literals.length} literals from T3's tests), ${differences} differences`);
process.exit(differences === 0 ? 0 : 1);
