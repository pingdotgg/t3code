/**
 * Fork-only. The taxonomy that decides what the Lathe rename does with every `t3` (any case) in
 * tracked files. Each occurrence goes to the first matching rule; while any occurrence matches no
 * rule the rename refuses to run, so new upstream code stops a sync until someone decides what its
 * names mean, instead of the codemod guessing.
 */

export const RENAME_CLASSES = [
  // Never leaves the build.
  "identifier",
  // Text a person reads.
  "display",
  // Names agents see: the MCP server and tools, prompt tags.
  "agent-facing",
  // Stored by the fork.
  "persisted",
  // Renaming would strand stored data or something the fork does not control.
  "kept",
  // Exchanged with services and clients the fork does not run.
  "wire-peer",
  // Credit or links to upstream.
  "upstream-reference",
  // Not a reference at all (uint32, encoded data).
  "false-positive",
] as const;
export type RenameClass = (typeof RENAME_CLASSES)[number];

export const RENAME_CLASS_ACTIONS: Readonly<Record<RenameClass, string>> = {
  identifier: "Renamed mechanically",
  display: "Substituted from the identity values",
  "agent-facing": "Renamed; old names stay recognised in stored tool calls",
  persisted: "Writes the Lathe name, reads both, warns on the old one",
  kept: "Kept byte-identical",
  "wire-peer": "Kept byte-identical",
  "upstream-reference": "Kept",
  "false-positive": "Ignored",
};

/** One `t3` hit in a tracked file. */
export interface RenameOccurrence {
  /** Repo-relative POSIX path. */
  readonly path: string;
  /** The identifier-ish run of characters around the hit. */
  readonly token: string;
  /** Offset of the hit inside `token`. */
  readonly offset: number;
  /** The full line holding the hit. */
  readonly line: string;
  /** Offset of the hit in the whole text. */
  readonly index: number;
  /** Offset of the hit in `line`. */
  readonly column: number;
  /** The line before `line`, or "" on the first line; object fields split across lines. */
  readonly previousLine: string;
  /** The line after `line`, or "" on the last line; prose wrapped across lines. */
  readonly nextLine: string;
}

export interface RenameRule {
  readonly id: string;
  readonly class: RenameClass;
  readonly reason: string;
  /** Tested against the token. */
  readonly token?: RegExp;
  /** Tested against the line. */
  readonly line?: RegExp;
  /** Tested against the path. */
  readonly path?: RegExp;
  /** Tested against the occurrence, for rules a pattern cannot express. */
  readonly test?: (occurrence: RenameOccurrence) => boolean;
  /**
   * Replaces the text from the hit instead of the brand units: `length`
   * characters become `text`. Only for renamed classes.
   */
  readonly rewrite?: (occurrence: RenameOccurrence) => RenameRewrite;
}

export interface RenameRewrite {
  readonly length: number;
  readonly text: string;
}

/** The characters that make up a token: identifiers, paths, URLs, package specifiers. */
export const RENAME_TOKEN_PATTERN = /[A-Za-z0-9_$@.:/\\-]*[tT]3[A-Za-z0-9_$@.:/\\-]*/g;

/** Every `t3` hit in `text`, as occurrences. */
export const findRenameOccurrences = (path: string, text: string): Array<RenameOccurrence> => {
  const occurrences: Array<RenameOccurrence> = [];
  let lineStart = 0;
  let previousLine = "";
  const lines = text.split("\n");
  for (const [lineNumber, line] of lines.entries()) {
    const nextLine = lines[lineNumber + 1] ?? "";
    for (const match of line.matchAll(RENAME_TOKEN_PATTERN)) {
      const token = match[0];
      for (let at = token.search(/t3/i); at !== -1;) {
        occurrences.push({
          path,
          token,
          offset: at,
          line,
          index: lineStart + match.index + at,
          column: match.index + at,
          previousLine,
          nextLine,
        });
        const next = token.slice(at + 2).search(/t3/i);
        at = next === -1 ? -1 : at + 2 + next;
      }
    }
    lineStart += line.length + 1;
    previousLine = line;
  }
  return occurrences;
};

const matches = (rule: RenameRule, occurrence: RenameOccurrence) =>
  (rule.path === undefined || rule.path.test(occurrence.path)) &&
  (rule.token === undefined || rule.token.test(occurrence.token)) &&
  (rule.line === undefined || rule.line.test(occurrence.line)) &&
  (rule.test === undefined || rule.test(occurrence));

/** The first rule that covers `occurrence`, or undefined when none does. */
export const classifyRenameOccurrence = (
  rules: ReadonlyArray<RenameRule>,
  occurrence: RenameOccurrence,
): RenameRule | undefined => rules.find((rule) => matches(rule, occurrence));

/** The character right before the hit inside its token, or "" at the token start. */
const before = (occurrence: RenameOccurrence) =>
  occurrence.token.slice(Math.max(0, occurrence.offset - 1), occurrence.offset);

/** True when the hit sits inside an escape such as `\nt3`, where the `n` is not a letter. */
const afterEscape = (occurrence: RenameOccurrence) =>
  /\\[nrt]$/.test(occurrence.token.slice(0, occurrence.offset));

/** True when the hit's own t is an escape letter (\t37): an odd run of backslashes precedes it. */
const isEscapeLetter = (occurrence: RenameOccurrence) =>
  (occurrence.token.slice(0, occurrence.offset).match(/\\+$/)?.[0].length ?? 0) % 2 === 1;

/** The token's word-part that holds the hit: its run of letters and digits. */
const stem = (occurrence: RenameOccurrence) => {
  const lead = occurrence.token.slice(0, occurrence.offset).replace(/^.*\\[nrt]/, "");
  const head = lead.match(/[A-Za-z0-9]*$/)?.[0] ?? "";
  const tail = occurrence.token.slice(occurrence.offset).match(/^[A-Za-z0-9]*/)?.[0] ?? "";
  return head + tail;
};

/**
 * The idioms upstream matches the MCP server name with. Each widens to accept
 * lathe beside the pre-Lathe spellings, which stored tool names keep; `done`
 * is the text a widened matcher has before the hit, so a second pass is a no-op.
 */
const MCP_MATCHER_WIDENINGS = [
  { from: "t3[-_ ]?code", to: "(?:lathe|t3[-_ ]?code)", done: "(?:lathe|" },
  { from: "t3-code|t3_code|t3code", to: "lathe|t3-code|t3_code|t3code", done: "lathe|" },
  {
    from: 't3-code", "t3_code", "t3code"',
    to: 'lathe", "t3-code", "t3_code", "t3code"',
    done: '"lathe", "',
  },
  { from: "t3_?code", to: "(?:lathe|t3_?code)", done: "(?:lathe|" },
  { from: "t3[-_]?code", to: "(?:lathe|t3[-_]?code)", done: "(?:lathe|" },
] as const;

const mcpMatcherWidening = (o: RenameOccurrence) => {
  const rest = o.line.slice(o.column);
  const head = o.line.slice(0, o.column);
  return MCP_MATCHER_WIDENINGS.find((w) => rest.startsWith(w.from) && !head.endsWith(w.done));
};

/**
 * A t3code repository name in a hosted remote (host/owner/t3code,
 * git@host:owner/t3code.git) or a bare slug (owner/t3code, group/sub/t3code). Local paths and the
 * desktop scheme's MIME type are not repositories.
 */
const isRepositorySlugName = (o: RenameOccurrence) => {
  const head = o.token.slice(0, o.offset);
  return (
    /^t3code(?:\.git)?(?![A-Za-z0-9-])/i.test(o.token.slice(o.offset)) &&
    (/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+[:/](?:[A-Za-z0-9_.-]+\/)+$/.test(
      head,
    ) ||
      (/^(?:[A-Za-z0-9_.-]+\/)+$/.test(head) && head !== "x-scheme-handler/"))
  );
};

/** Upstream identity values the fork replaces with FORK_IDENTITY. */
const UPSTREAM_IDENTITY_TOKEN =
  /com\.t3tools\.(?:t3code|T3Code)|^t3code(?:-dev|-v2)?(?::|:\/\/app)?$|\/t3code\.service|\/usr\/share\/doc\/t3code|node_modules\\?\/t3\\?\/|bin\\?\/t3\\?\.mjs|^manifest\.bin\.t3$|registry\.npmjs\.org\/t3\/|^hello@t3\.codes$|^t3-install$|t3-antigravity-browser-preflight/;

/** Files where upstream names its CLI `t3` and the fork uses FORK_IDENTITY.cliBin. */
const UPSTREAM_CLI_FILES =
  /^apps\/server\/src\/cli\/invocation\.ts$|^apps\/desktop\/src\/backend\/DesktopBackendConfiguration\.ts$|^scripts\/(?:install\.(?:sh|ps1)|build-npm-launcher\.ts|npm-launcher\/bin\.mjs)$/;

/** Upstream lines the fork rewrites around FORK_IDENTITY, by path and line. */
const UPSTREAM_REPLACED_IDENTITY_LINES: ReadonlyArray<readonly [string, RegExp]> = [
  ["apps/desktop/scripts/electron-launcher.mjs", /com\.t3tools\.t3code|APP_PROTOCOL_SCHEMES/],
  ["apps/desktop/src/app/DesktopCliShim.ts", /^export const MARKER = "/],
];

let rulesWithoutMobile: ReadonlyArray<RenameRule> | undefined;

/**
 * Mobile source that must change with shared code even while mobile keeps its names: imports of
 * renamed packages and exports, the attribution value shared code produces, and the text and agent
 * names shared code renders, which mobile shows and its tests assert. Native module names, fonts,
 * storage keys and bundle ids are none of these, so they stay.
 */
const mobileFollowsSharedCode = (o: RenameOccurrence): boolean => {
  if (/@t3tools/.test(o.token)) return true;
  // Lint directives name the shared oxlint plugin, in scripts as well as src.
  if (/^t3code\/[a-z-]+$/.test(o.token) && /lint-(?:disable|enable)/.test(o.line)) return true;
  if (!/^apps\/mobile\/src\/.*\.tsx?$/.test(o.path)) return false;
  if (o.token === "t3code" && /\battribution\b/.test(o.line)) return true;
  rulesWithoutMobile ??= FORK_RENAME_RULES.filter((rule) => rule.id !== "kept-mobile-app");
  const rule = classifyRenameOccurrence(rulesWithoutMobile, o);
  return (
    rule !== undefined &&
    (rule.class === "display" ||
      rule.class === "agent-facing" ||
      (rule.class === "persisted" && rule.id !== "persisted-env") ||
      rule.id === "id-lint-plugin")
  );
};

export const FORK_RENAME_RULES: ReadonlyArray<RenameRule> = [
  {
    id: "kept-rename-rules",
    class: "kept",
    reason:
      "The rename's own rules, codemod, report and sync guide, which must keep naming the old forms.",
    path: /^scripts\/(?:lib\/forkRename(?:Rules|Codemod)(?:\.test)?\.ts|fork-rename-(?:report|codemod)\.ts)$|^docs\/internals\/fork-upstream-sync\.md$/,
  },
  {
    id: "kept-hosted-link-thread-id-fixture",
    class: "kept",
    reason:
      "A thread id fixture spelled t3 that the same test also writes inside a kept app.t3.codes link.",
    test: (o) =>
      o.path === "packages/shared/src/composerContextReferences.test.ts" &&
      /^["'`]t3["'`]/.test(o.line.slice(o.column - 1)),
  },
  {
    id: "kept-fork-legacy-compat",
    class: "kept",
    reason:
      "Fork compat modules that read the old names after the rename (files named forkLegacy*).",
    path: /(?:^|\/)forkLegacy[A-Za-z]*(?:\.test)?\.(?:tsx?|js)$/,
  },
  {
    id: "upstream-agent-artifacts",
    class: "upstream-reference",
    reason:
      "Agent instruction files and skills (.agents, .cursor, .claude, AGENTS.md, CLAUDE.md): upstream ships them and the fork never edits them.",
    path: /^\.(?:agents|cursor|claude|codex)\/|(?:^|\/)(?:AGENTS|CLAUDE|GEMINI)\.md$/,
  },
  {
    id: "id-package-scope",
    class: "identifier",
    reason:
      "Workspace package scope and module subpaths; every package is workspace-local (renamed to @lathe/), and a subpath names a module the package renames. First, because upstream-only areas import workspace packages too.",
    test: (o) =>
      /^@t3tools(?:\/|$)/.test(o.token.slice(Math.max(0, o.offset - 1))) ||
      /(?:^|[^A-Za-z0-9])@t3tools\/[a-z-]+\//.test(o.token.slice(0, o.offset)),
  },
  {
    id: "id-imported-workspace-exports",
    class: "identifier",
    reason:
      "Workspace-package exports that the kept mobile app and upstream's site import; they rename with the packages.",
    path: /^apps\/(?:mobile|marketing)\//,
    token:
      /(?:^|[^A-Za-z0-9_$])(?:T3McpTool(?:Logo|Presentation)|resolveT3McpTool(?:Definition|Presentation)|T3_CODE_(?:DARK|LIGHT)_THEME_COLORS|T3_PROJECT_FILE_NAME|parseT3ProjectFile|buildT3ProjectFileJsonSchema)(?:$|[^A-Za-z0-9_$])/,
  },
  // false positives: a "t3" that is part of another word or of encoded data
  {
    id: "upstream-marketing-site",
    class: "upstream-reference",
    reason: "apps/marketing is upstream's site and legal pages; the fork does not deploy it.",
    path: /^apps\/marketing\//,
  },
  {
    id: "upstream-aur-packaging",
    class: "upstream-reference",
    reason:
      "packaging/aur is upstream's AUR package, published only by upstream's release workflow, and the test that runs its release script.",
    path: /^packaging\/|^scripts\/aur-release\.test\.ts$/,
  },
  {
    id: "upstream-task-cache",
    class: "upstream-reference",
    reason:
      "Upstream's shared Vite task cache: the endpoint, its service under infra/task-cache, and the CI read token that wires it up. The fork has no token, so CI skips it.",
    test: (o) =>
      // Its lint directives name the shared oxlint plugin, which the fork renames.
      !(/^t3code\/[a-z-]+$/.test(o.token) && /lint-(?:disable|enable)/.test(o.line)) &&
      (/^(?:\.task-cache\.json$|infra\/task-cache\/)/.test(o.path) ||
        /T3_TASK_CACHE_/.test(o.token)),
  },
  {
    id: "upstream-linux-metainfo",
    class: "upstream-reference",
    reason: "Upstream's AppStream metainfo, which the fork does not ship.",
    path: /metainfo\.xml$/,
  },
  {
    id: "upstream-release-workflow",
    class: "upstream-reference",
    reason:
      "Upstream's own release workflow, disabled in the fork, and the test that runs its relay state step.",
    path: /^\.github\/(?:workflows\/release\.yml|scripts\/relay-state-output\.test\.cjs)$/,
  },
  {
    id: "kept-vendored-dependency-versions",
    class: "kept",
    reason:
      "Version suffixes of vendored dependency tarballs (-t3.13); the version inside each tarball says the same.",
    token: /-t3\.\d+/,
  },
  {
    id: "upstream-vendored-dependency-notes",
    class: "upstream-reference",
    reason:
      "How upstream builds the tarballs under apps/web/deps: its fork branches and the -t3.N versions the kept tarball names carry.",
    path: /^apps\/web\/deps\/README\.md$/,
  },
  {
    id: "id-managed-policy-paths",
    class: "identifier",
    reason:
      "Where an administrator deploys the managed policy; Lathe reads its own, so a T3 Code policy on the same machine never governs it.",
    token: /^["'`]?\/etc\/t3code\/policy\.json|Support\/T3Code\/policy\.json/,
  },
  {
    id: "id-renamed-doc-paths",
    class: "identifier",
    reason:
      "Repo paths of user docs and product skills, which display-docs-prose renames along with the file.",
    token: /^["'`]?(?:docs\/user\/t3-[a-z-]+\.md|(?:\.\.\/)*skills\/t3-[a-z-]+\/)/,
  },
  {
    id: "upstream-connect-doc",
    class: "upstream-reference",
    reason:
      "The internal doc about upstream's T3 Connect service, under either name upstream has given it.",
    path: /^docs\/internals\/(?:\d+_)?t3-connect\.md$/,
  },
  {
    id: "upstream-connect-doc-links",
    class: "upstream-reference",
    reason:
      "Paths and links to that doc from other files, which resolve only while they name the file as upstream does.",
    token: /(?:^|\/)(?:\d+_)?t3-connect\.md/,
  },
  {
    id: "upstream-connect-troubleshooting-anchors",
    class: "upstream-reference",
    reason:
      "Troubleshooting anchors for headings that name upstream's T3 Connect service, which the fork's copy of the doc keeps.",
    token:
      /the-t3-connect-address-does-not-resolve-or-answer|this-device-cant-reach-t3-connect|t3-connect-returned-an-error/,
  },
  {
    id: "display-connect-troubleshooting-anchors",
    class: "display",
    reason: "Troubleshooting anchors for headings that name the product, renamed with the doc.",
    token: /the-host-runs-an-older-t3-code/,
  },
  {
    id: "kept-mobile-app",
    class: "kept",
    reason:
      "The mobile app keeps upstream's identity, native module names, fonts and paths until its own rename project; only what follows renamed shared code changes.",
    path: /^apps\/mobile\/|^\.github\/workflows\/mobile-|^scripts\/mobile-/,
    test: (o) => !mobileFollowsSharedCode(o),
  },
  {
    id: "kept-mobile-native-modules",
    class: "kept",
    reason:
      "Mobile native module packages and directories (t3-terminal, expo.modules.t3*), referenced from outside apps/mobile; renamed with the mobile project.",
    token:
      /expo\.modules\.t3|modules\/t3-|(?:^|[^A-Za-z])t3-(?:terminal|native-controls|source-text|review-diff|composer-editor|widget-expiry|agent-notifications|markdown-text)\b|^t3(?:terminal|nativecontrols|sourcetext|reviewdiff|composereditor|widgetexpiry|agentnotifications)$/,
  },
  {
    id: "kept-mobile-paths",
    class: "kept",
    reason:
      "Paths into apps/mobile named from outside it, such as lint config file lists; mobile files keep their names.",
    test: (o) => {
      const start = o.token.indexOf("apps/mobile/");
      return start !== -1 && start < o.offset;
    },
  },
  {
    id: "kept-mobile-app-links",
    class: "kept",
    reason:
      "Deep links a scenario opens in the mobile app, which keeps upstream's schemes (kept-mobile-sandbox).",
    path: /^scripts\/scenarios\//,
    token: /^["'`]?t3code(?:-dev|-preview)?:\/\//,
    line: /\bdevice\.openLink\(/,
  },
  {
    id: "fp-inside-word",
    class: "false-positive",
    reason: "Lowercase t3 inside a word or number: uint32, project3, Object3D.",
    test: (o) => o.token[o.offset] === "t" && /[A-Za-z0-9]/.test(before(o)) && !afterEscape(o),
  },
  {
    id: "fp-escape-letter",
    class: "false-positive",
    reason:
      'A tab escape followed by digits in a string: in "\\t37" the t is the escape\'s letter.',
    test: (o) => o.token[o.offset] === "t" && isEscapeLetter(o),
  },
  {
    id: "fp-uppercase-word",
    class: "false-positive",
    reason: "Uppercase T3 inside a word and followed by a digit: VT320, INT32.",
    test: (o) =>
      o.token[o.offset] === "T" &&
      /[A-Z]/.test(before(o)) &&
      /\d/.test(o.token[o.offset + 2] ?? ""),
  },
  {
    id: "fp-encoded-data",
    class: "false-positive",
    reason: "Base64 or hashed data: embedded images, lockfile integrity, signatures.",
    test: (o) =>
      /base64,|integrity|sha(?:256|512)-/.test(o.line) ||
      // Long generated identifiers are letters only; encoded data has digits or padding.
      (/^[A-Za-z0-9+/=]{40,}$/.test(stem(o)) && /[0-9+/=]/.test(stem(o).replace(/t3/gi, ""))),
  },

  {
    id: "kept-cursor-sdk-patch",
    class: "kept",
    reason:
      "Names inside the @cursor/sdk patch: the bundle's own minified names (T30) and the locals the patch adds (__t3m, __t3kept); the patch stays as written so it applies to the published bundle.",
    path: /^patches\/@cursor__sdk@[^/]+\.patch$/,
  },

  {
    id: "id-scenario-harness",
    class: "identifier",
    reason:
      "The e2e scenario harness: its t3.ts and t3-mobile.ts modules, the t3 fixture every scenario takes, the worktree branch prefix it lists, and its simulator tenant, tmux socket and home argument. prove-scenario.ts finds iOS scenarios by the mobile module's name, so both rename together.",
    test: (o) =>
      ((o.path.startsWith("scripts/scenarios/") || o.path === "scripts/prove-scenario.ts") &&
        /^(?:\.\/)?t3(?:-mobile)?(?:\.ts)?[:/]?$|^t3-scenario-[a-z-]+-\$$/.test(o.token)) ||
      (o.path === "scripts/scenarios/start-app.ts" && o.token === "t3-home") ||
      (o.path === "scripts/e2e.config.ts" && o.token === "t3-scenarios"),
  },

  // wire-peer: exchanged with services and clients the fork does not run.
  // Lathe builds use upstream's T3 Connect (relay.t3.codes, clerk.t3.codes,
  // app.t3.codes), and upstream's hosted app and mobile app can talk to a
  // Lathe server, so these stay byte-identical (jamesainslie/t3code#71).
  {
    id: "wire-upstream-relay-source",
    class: "wire-peer",
    reason:
      "infra/relay is upstream's relay source; the fork never deploys it, and it shares the protocol with the server.",
    path: /^infra\/relay\//,
  },
  {
    id: "wire-relay-protocol",
    class: "wire-peer",
    reason:
      "Relay protocol: JWT types and issuers, headers, routes, client ids and literals the relay checks.",
    token:
      /t3-env:|t3-(?:env|cloud|relay)-[a-z-]+\+jwt|x-t3-(?:relay|hook)-|\/api\/t3-connect\b|t3MintCredential|^["'`]?t3-(?:web|mobile)["'`]?[,;)]?$|^["'`]?t3_relay["'`]?|t3-code-relay|^["'`]?t3-relay["'`]?,?$/,
  },
  {
    id: "wire-relay-type-names",
    class: "wire-peer",
    reason: "Relay JWT type names declared in the shared relay constants.",
    path: /relayJwt\.ts$/,
    token: /t3-(?:env|cloud|relay)-[a-z-]+/,
  },
  {
    id: "wire-upstream-hosts",
    class: "wire-peer",
    reason: "Upstream's Connect hosts and Clerk instance, used as-is.",
    token:
      /(?:^|[^a-z])(?:relay|clerk|app|nightly\\?\.app|preview|ingest)\\?\.t3\\?\.codes|(?:^|[^A-Z])(?:RELAY|CLERK|APP|PREVIEW|INGEST)\.T3\.CODES|Y2xlcmsudDMuY29kZXMk/,
  },
  {
    id: "wire-client-protocol",
    class: "wire-peer",
    reason:
      "Server surface upstream clients speak: discovery, the protocol header, the preview tunnel's refusal headers (the kept mobile app's native tunnel reads them too), the bootstrap token type, telemetry shapes.",
    token:
      /\/\.well-known\/t3\b|x-t3-orchestration-protocol|x-t3-tunnel-(?:port-refused|disabled)|urn:t3:params|(?:^|\.)["'`]?allT3(?:["'`:]?$|\.)|unknown-t3|^["'`]?t3_kind["'`]?/,
  },
  {
    id: "wire-server-installation-kind",
    class: "wire-peer",
    reason:
      "The t3-launcher server installation kind in environment capabilities. Upstream's hosted and mobile clients build a Lathe server's update command from it, and a Lathe client an upstream server's; no Lathe release stores or sends another name.",
    token: /^["'`]?t3-launcher["'`]?[,;)]?$/,
  },
  {
    id: "wire-mcp-app-color-scheme",
    class: "wire-peer",
    reason:
      "The t3-color-scheme query parameter: the client sets it on an MCP app frame URL and the server's injected bootstrap reads it, so upstream's hosted app and a Lathe server must agree.",
    token: /^["'`]?t3-color-scheme["'`]?/,
  },
  {
    id: "wire-mcp-app-document-channel",
    class: "wire-peer",
    reason:
      "The MCP app document handshake: the server's injected bootstrap posts { t3: \"t3-mcp-app-document\" } and the client reads it, so upstream's hosted app, the kept mobile app and a Lathe server must agree.",
    test: (o) =>
      /^["'`]?t3-mcp-app-document["'`]?;?$/.test(o.token) ||
      (/MCP_APP_DOCUMENT_MESSAGE/.test(o.line) && /^\.?t3:?\$?$/.test(o.token)),
  },
  {
    id: "wire-telemetry-names",
    class: "wire-peer",
    reason:
      "Names in telemetry sent to upstream's PostHog and relay trace datasets (off by default).",
    test: (o) =>
      /(?:^|\.)t3CodeVersion:?$|t3\.client\.|^t3_child$|^["'`]?t3code-(?:server|desktop|web)["'`]?,?$|service\.namespace/.test(
        o.token,
      ) || /service\.namespace|service\.runtime|serviceName:/.test(o.line),
  },

  {
    id: "wire-credential-owner",
    class: "wire-peer",
    reason:
      'The credential owner literal "t3" in provider auth state and bindings, which upstream clients decode.',
    test: (o) =>
      o.token === "t3" &&
      /(?:\bowner|credentialOwner)\??:/.test(o.line) &&
      /["'`]t3["'`]/.test(o.line),
  },
  {
    id: "kept-model-manifest-range",
    class: "kept",
    reason:
      "The t3CodeRange field of the model manifest, which released builds fetch from the fork's main branch.",
    token: /(?:^|\.)["'`]?t3CodeRange["'`:]*$/,
  },
  {
    id: "wire-vendor-identities",
    class: "wire-peer",
    reason:
      "Client identities provider vendors see (OpenAI, xAI, ACP agents, Muse); the fork reports as upstream.",
    test: (o) =>
      (/CODEX_CLIENT_NAME|agent_name_hint|OAUTH2?_REFERRER|clientInfo|createdByClient|clientName/.test(
        o.line,
      ) &&
        /^(?:T3|t3_code|t3-code|t3code|T3_CODE_OAUTH_REFERRER)$/.test(
          stem(o) === "T3" ? "T3" : o.token.replace(/^["'`]|["'`,;:)}]+$/g, ""),
        ) &&
        !o.path.endsWith(".ndjson")) ||
      // Replay transcripts: only hits inside a clientInfo object, since one frame holds other text too.
      (o.path.endsWith(".ndjson") && /"clientInfo":\{[^{}]*$/.test(o.line.slice(0, o.column))) ||
      /^["'`]?t3-code-(?:text|provider-setup|acp-cli|provider-auth|provider-test|session-manager|provider-probe|git-text)["'`]?/.test(
        o.token,
      ),
  },
  {
    id: "wire-t3-chat-link",
    class: "wire-peer",
    reason:
      "T3 Chat, upstream's sibling product, is never Lathe's: its account link names (routes, types, plan limits, labels), the t3.chat site and doc anchors. Lathe uses upstream's relay.",
    token:
      /T3CHAT_|t3chat|T3Chat|t3Chat|with-t3-chat|^t3\.chat[.,]?$|https:\/\/t3\.chat\/settings\//,
  },
  {
    id: "wire-peer-links",
    class: "wire-peer",
    reason:
      "Peer links between environments: the OAuth software id and redirect URI, the MCP client name and the T3-Mode-Limit and T3-Sender-Thread headers, which the server on the other end may be upstream's.",
    test: (o) => /t3code-peer|t3-mode-limit|t3-sender-thread/i.test(o.token),
  },
  {
    id: "kept-npm-release-manifest-key",
    class: "kept",
    reason:
      "The t3code field of the published npm launcher manifest, read by release checks; writer and reader must agree.",
    path: /^scripts\/build-npm-launcher\.ts$|^packages\/shared\/src\/cliRelease\.ts$/,
    test: (o) =>
      /^\.?t3code:?$/.test(o.token.replace(/^["'`]|["'`,;)}]+$/g, "")) &&
      /[dD]atabaseMigration|\.t3code\b|^\s*t3code:/.test(o.line),
  },

  // kept: renaming would strand stored data or something the fork does not control
  {
    id: "kept-synced-thread-ids",
    class: "kept",
    reason:
      "t3sync- thread and t3syncasset- ids are matched by prefix in SQL and the sync planner; renaming duplicates every synced thread.",
    token: /t3sync(?:asset)?-?/,
  },
  {
    id: "kept-capture-data-dir",
    class: "kept",
    reason:
      "The t3code segment of the Linux capture helpers' data directory, which an upstream install also writes; and the WSL tree marker legacy cleanup still reads.",
    test: (o) =>
      (/dataHome|extension-backups|capture/.test(o.line) && o.token === "t3code") ||
      /t3code-wsl-server-tree\.json/.test(o.token),
  },
  {
    id: "kept-cross-version-env",
    class: "kept",
    reason:
      "Variables a pinned service launcher passes to newer and older servers, and that installed unit files hold.",
    token: /T3_SERVICE_LAUNCHER_CONTEXT|T3_BOOT_SERVICE_UNIT/i,
  },
  {
    id: "kept-os-registrations",
    class: "kept",
    reason:
      "Bundle id, boot service units and Apple records the fork already keeps on purpose: a new id is a new app to the OS.",
    token: /us\.ainslies\.t3code|com\.t3tools\.t3code\.service|t3code-fork\.service/,
  },
  {
    id: "kept-project-file-schema",
    class: "kept",
    reason:
      "The project file schema hosted on t3.codes, and .t3code/vcs.json read from users' repos and shared with upstream users.",
    token: /t3\.codes\/schema|\.t3code\/vcs\.json/,
  },
  {
    id: "persisted-project-file",
    class: "persisted",
    reason:
      "The project file in users' repos: Lathe reads lathe.json first and falls back to t3.json, which upstream users share. It never writes either.",
    token: /(?:^|[^A-Za-z])t3\.json|T3_PROJECT_FILE_NAME/,
  },
  {
    id: "kept-checkpoint-refs",
    class: "kept",
    reason:
      "refs/t3/ checkpoint refs in users' repos, shared with upstream installs; the previous ref is recomputed from the prefix.",
    token: /refs\/t3\//,
  },
  {
    id: "kept-git-branch-config",
    class: "kept",
    reason:
      "branch.<name>.t3-merge-base and t3-pull-request keys in users' repos' git config; they describe the branch, so both apps share them.",
    token: /(?:^|[."'`])t3-(?:merge-base(?:-ref)?|pull-request)\b/,
  },
  {
    id: "kept-checkpoint-trailer",
    class: "kept",
    reason:
      "The T3-Head-Moved-At trailer in checkpoint commits under refs/t3/, read back from the previous checkpoint; threads synced from upstream continue from upstream's checkpoints.",
    token: /^["'`]?T3-Head-Moved-At\b/,
  },
  {
    id: "kept-provider-update-lock",
    class: "kept",
    reason:
      "The machine-wide lock directory for provider CLI updates (t3code-provider-updates); upstream servers on the same machine update the same provider installs, so sharing the lock keeps them from replacing files under each other.",
    token: /^["'`]?t3code-provider-updates["'`]?/,
  },
  {
    id: "kept-integration-fixture-owner",
    class: "kept",
    reason:
      "The t3 owner in the transfer budget fixture's remote and canonical key, kept with the owner field beside them (wire-credential-owner).",
    path: /^apps\/server\/integration\//,
    token: /github\.com[:/]t3\//,
  },
  {
    id: "kept-vendored-binary-imports",
    class: "kept",
    reason:
      "Names compiled into vendored binaries: t3_write_pty, the host import of ghostty-write-pty.wasm (built from apps/web/scripts/ghostty-write-pty.zig).",
    token: /(?:^|[^A-Za-z0-9_])t3_write_pty(?:$|[^A-Za-z0-9_])/,
  },
  {
    id: "kept-desktop-package-name",
    class: "kept",
    reason:
      "The bundled desktop package.json name (t3code), which names the macOS keychain item holding safeStorage secrets, and upstream's updater cache directory derived from it.",
    test: (o) =>
      (/^scripts\/build-desktop-artifact(?:\.test)?\.ts$/.test(o.path) &&
        /^\s*name: "t3code",?$/.test(o.line)) ||
      (/DesktopForkUpdaterCacheDir(?:\.test)?\.ts$/.test(o.path) && /^t3code/.test(o.token)),
  },
  {
    id: "kept-capture-app-id-fixture",
    class: "kept",
    reason:
      "The app id fixture in SnapShot tests, from which the tests derive the kept capture ids.",
    path: /^apps\/desktop\/src\/snapShot\/.*\.test\.ts$/,
    token: /com\.t3tools\.T3Code/,
  },
  {
    id: "kept-capture-helper-binaries",
    class: "kept",
    reason:
      "The KDE and Hyprland SnapShot helper binaries (t3-<backend>-snap-shot), named by their Cargo packages.",
    test: (o) => /t3-\$/.test(o.token) && /-snap-shot/.test(o.line),
  },
  {
    id: "kept-linux-capture-helpers",
    class: "kept",
    reason:
      "SnapShot helpers, desktop file, GNOME extension and portal shortcut ids that an upstream install on the same machine also writes.",
    token:
      /\/com\/t3tools\/|share\/t3code|t3code\/(?:kde|hyprland)-capture|extension-backups|com\.t3tools\.(?:T3Code\.(?:Development\.)?SnapShot|T3Code\.KdeCapture|KdeCapture|SnapShot|T3Code\.SnapShot|T3Code:capture)|X-T3Code-Capture-Helper|snap-shot@t3\.codes|T3SnapShot|t3-snap-shot-|t3-(?:kde|hyprland)-snap-shot/,
  },
  {
    id: "kept-upstream-home",
    class: "kept",
    reason: "~/.t3 as upstream's install, read by project sync and the dev-data scripts.",
    test: (o) =>
      /(?:^|[/~"'`])\.t3(?:$|[/"'`])/.test(o.token) &&
      !/\.mdx?$/.test(o.path) &&
      /projectSync|migrate-dev-db|(?:t3|lathe)-sqlite-state|upstream/i.test(o.path + o.line),
  },
  {
    id: "kept-mobile-sandbox",
    class: "kept",
    reason:
      "Mobile storage, schemes and bundle ids: the app keeps upstream's bundle ids, so these live in upstream's sandbox until the fork ships its own app.",
    path: /^apps\/mobile\//,
    token:
      /^["'`]?t3code\.|t3code-client\.db|t3-composer-|t3-attachment|t3-favicon-thumbnail|t3-agent-notifications|com\.t3tools\.t3code|^["'`]?t3code(?:-dev|-preview)?:?\/\/|^["'`]?t3code(?:-dev|-preview)["'`]?/,
  },

  // persisted: stored by the fork; write the Lathe name, read both, warn
  {
    id: "persisted-link-schemes",
    class: "persisted",
    reason:
      "Citation, thread and context links stored in message text; upstream clients send the t3 forms too.",
    token: /t3-(?:citation|thread|context):|^["'`]?t3-(?:citation|thread|context)["'`]?,?$/,
  },
  {
    id: "kept-indexeddb-databases",
    class: "kept",
    reason:
      "IndexedDB databases holding saved connections and the cloud auth key; a database cannot be renamed in place, so they keep their names.",
    token: /^t3code:(?:connection-runtime|cloud-auth)$/,
  },
  {
    id: "persisted-renderer-storage",
    class: "persisted",
    reason:
      "Renderer localStorage and IndexedDB keys holding user data and preferences; the desktop import copies them by name.",
    test: (o) =>
      /^["'`]?(?:t3code[:.][a-z]|t3[:.](?:pullRequests\.(?:preferences|savedViews)|issues\.|backgroundActivity|chatgpt))/.test(
        o.token.slice(Math.max(0, o.offset - 1)),
      ) &&
      !/t3code:(?:open-command-palette|preview-action|focus-composer|local_storage_change|github-routing-changed|update-everything-result|snap-shot-setup-resume|chunk-load-reloaded|dev-compression|project-favicons)|t3\.pullRequests\.(?:detail|list)/.test(
        o.token,
      ),
  },
  {
    id: "kept-connection-profile",
    class: "kept",
    reason:
      'The "t3-connect" authorization literal stored in saved connection catalogs, and code that compares a profile against it.',
    test: (o) =>
      o.token === "t3-connect" &&
      (/client-runtime\/src\/connection\//.test(o.path) ||
        /\bauthorization\b|bearerProfile\(/.test(o.line)),
  },
  {
    id: "kept-theme-ids",
    class: "kept",
    reason:
      "Built-in theme ids stored as the selected theme (and sent to clients as the environment theme).",
    test: (o) =>
      !/syntax(?:Themes|Highlighting)/i.test(o.path) &&
      (/^["'`]?t3-(?:chat|grove|ocean|ember|iris)(?:-(?:dark|light))?["'`]?[,;:)]?$|T3_CHAT_THEME|LEGACY_T3_CHAT/.test(
        o.token,
      ) ||
        ((/[Tt]heme/.test(o.path) ||
          /[Tt]heme(?:Variables)?\(|\bpalettes?\b|\b(?:themeIds?|requestedTheme)\b/.test(o.line)) &&
          /^t3-(?:code|chat|grove|ocean|ember|iris)(?:-(?:dark|light))?$/.test(o.token))),
  },
  {
    id: "kept-default-variant-choice",
    class: "kept",
    reason:
      "The t3:default variant choice id, stored in a thread's model selection and sent to clients, which upstream's clients compare against.",
    token: /^["'`]?t3:default["'`]?[,;)]?$/,
  },
  {
    id: "upstream-homebrew-cask",
    class: "upstream-reference",
    reason: "Upstream's Homebrew cask; the fork publishes none.",
    line: /brew install --cask t3-code\b/,
  },
  {
    id: "persisted-session-cookie",
    class: "persisted",
    reason: "The t3_session cookie; the server already reads one legacy name.",
    token: /(?:^|[^a-z])t3_session(?!.*dev)/,
  },
  {
    id: "kept-cross-version-ipc",
    class: "kept",
    reason:
      "Names two different versions must agree on: the desktop control socket, bootstrap token label, clipboard MIME.",
    token: /t3code-app-|t3-desktop-bootstrap|(?:x|data)-t3-context-fragment/,
  },
  {
    id: "kept-desktop-state",
    class: "kept",
    reason:
      "Desktop and host state read back across runs: preview browser partitions, the AppArmor profile, WSL runtime markers.",
    token: /persist:t3code-preview|t3code-preview-|t3-chrome-headless-shell|\.t3code-wsl-runtime-/,
  },
  {
    id: "persisted-pr-branches",
    class: "persisted",
    reason: "t3code/pr-<n>/ checkout branches read back when a worktree is reused.",
    token: /t3code\/pr-|t3code-pr-/,
  },
  {
    id: "kept-legacy-fork-names",
    class: "kept",
    reason:
      "Pre-Lathe fork names the fork already reads as legacy: .t3f, t3f, t3code-fork, t3code/<hex> branches, boot service units.",
    token:
      /\.t3f\b|^t3f$|t3f\.cmd|t3code-fork|app-t3code-fork|t3code[/-]<|^["'`]?t3code["'`]?,?$(?=)/,
    test: (o) =>
      !/^["'`]?t3code["'`]?,?$/.test(o.token) ||
      /legacy|LEGACY|worktreeBranchPrefix|systemdName/.test(o.line),
  },
  {
    id: "kept-legacy-temp-branches",
    class: "kept",
    reason:
      "Pre-Lathe temporary worktree branches (t3code/<hex>, t3code-<hex>) the matcher keeps recognising.",
    path: /^packages\/shared\/src\/git(?:\.test)?\.ts$/,
    test: (o) =>
      /^t3code[/-][0-9a-f]{8}/.test(o.token) || (/^t3code[/-]$/.test(o.token) && /</.test(o.line)),
  },
  {
    id: "id-build-and-test-env",
    class: "identifier",
    reason:
      "T3CODE_* variables only the fork's own build, dev tooling and tests set, plus build-time markers.",
    test: (o) =>
      /^__T3CODE_|^T3CODE_(?:DESKTOP_(?:PLATFORM|TARGET|ARCH|VERSION|OUTPUT_DIR|SKIP_BUILD|KEEP_STAGE|SIGNED|VERBOSE|WSL_RUNTIME|UPDATE_REPOSITORY|REUSE_[A-Z_]+|MOCK_[A-Z_]+|APP_USER_MODEL_ID|PROTOCOL_REGISTRATION_MANAGED|REMOTE_DEBUGGING_PORT|WS_URL|LAN_ACCESS|DEV)|PACK_EXE[A-Z_]*|WEB_(?:SOURCEMAP|ROUTER_URL|LATEST_DOMAIN|NIGHTLY_DOMAIN)|BUNDLED_DEV|SINGLE_ORIGIN_DEV|DEV_ALLOWED_HOSTS|LICENSES_STRICT|CLI_MAC_SIGN_IDENTITY|RELAY_CLIENT_CONFIG_ENV|TRANSFER_BUDGET_[A-Z_]+|COMMIT_HASH|DEV_REMOTE_T3_SERVER_ENTRY_PATH|CURSOR_ENABLED|SECRET|SELECT_SCRIPT|INSTALL_SCRIPT|TEST_HEADLESS_SHELL|ENV_[A-Z_]+__)\b/.test(
        o.token.slice(o.offset - (o.token.slice(0, o.offset).endsWith("__") ? 2 : 0)),
      ),
  },
  {
    id: "persisted-exported-env",
    class: "persisted",
    reason:
      "T3CODE_PROJECT_ROOT and T3CODE_WORKTREE_PATH are set for users' project scripts, and T3_PROJECT_ROOT and T3_WORKTREE_* for a project's worktree layout command: export both names, not read both.",
    test: (o) =>
      /T3CODE_(?:PROJECT_ROOT|WORKTREE_PATH)/.test(o.token) ||
      /^T3_(?:PROJECT_ROOT|WORKTREE_(?:ROOT|PROJECT_PATH|BRANCH|BASE|REPOSITORIES))(?![A-Z0-9_])/.test(
        o.token.slice(o.offset),
      ),
  },
  {
    id: "kept-stored-output-key",
    class: "kept",
    reason: "The t3McpApp key in stored tool output, matched by SQL LIKE and the output decoder.",
    token: /t3McpApp/,
  },
  {
    id: "kept-provider-side-state",
    class: "kept",
    reason:
      "Names other processes keep across upgrades: OpenCode's per-session instruction key, the ACP stale-cgroup prefix, the desktop control socket directory.",
    test: (o) =>
      (/opencode\/src\/server\/v2\//.test(o.path) && /INSTRUCTIONS_KEY/.test(o.line)) ||
      (o.token === "t3-code" && /instructions\.entry\.put|^\s*key: "t3-code",?$/.test(o.line)) ||
      (/AcpSessionRuntime/.test(o.path) && /t3-acp-/.test(o.token)) ||
      (/desktopAppControl/.test(o.path) && /t3code-/.test(o.token)),
  },
  {
    id: "kept-legacy-home-matchers",
    class: "kept",
    reason:
      "Matchers that recognise worktrees under any of the home directory names (.t3, .lathe, .t3f).",
    line: /\(\?:t3\|lathe\|t3f\)/,
  },
  {
    id: "persisted-env",
    class: "persisted",
    reason:
      "T3CODE_* environment variables users, unit files, shell profiles and docs set. LATHE_* becomes the name; T3CODE_* stays an alias that is read with a warning. Installed boot units hold T3CODE_HOME, so the unit parser and its staleness check must accept both too.",
    test: (o) =>
      /^(?:VITE_)?T3CODE_[A-Z0-9_]*/.test(
        o.token.slice(
          Math.max(0, o.offset - (o.token.slice(0, o.offset).endsWith("VITE_") ? 5 : 0)),
        ),
      ),
  },
  {
    id: "kept-html-render-bootstrap",
    class: "kept",
    reason:
      "Names baked into stored html_render pages and the scripts beside them: the t3-theme and t3-contain-scroll fragments and style, t3/notifications and t3/file-preview methods, t3-link ids.",
    token: /t3-theme|t3-contain-scroll|t3\/notifications|t3\/file-preview\/|t3-link-/,
  },

  // upstream references: credit, links, and upstream's own published names
  {
    id: "upstream-repo",
    class: "upstream-reference",
    reason: "Links to upstream's repository, issues and pull requests.",
    token: /(?:pingdotgg|t3dotgg|T3Tools|t3tools)\/t3code|github\.com\/pingdotgg|t3dotgg\b/i,
  },

  {
    id: "id-cli-archive-build-input",
    class: "identifier",
    reason:
      "build-cli-archive.ts reads the executable the server build writes (dist-exe/lathe) and names it in hints and logs; only the archive stem and the alias it documents keep t3.",
    path: /^scripts\/build-cli-archive\.ts$/,
    test: (o) => stem(o) === "t3" && !/t3-\$\{version\}/.test(o.line) && !/as `t3`/.test(o.line),
  },
  {
    id: "kept-cli-literal",
    class: "kept",
    reason:
      "The executable name as a quoted literal in the files that install and run the CLI; forkCliArtifacts.ts keeps the t3 fallback.",
    path: /forkCliArtifacts|forkCliArchive|fork-cli-release-assets|cliRelease|build-cli-archive|install\.(?:sh|ps1)|scripts\/install\.test\.ts|pinnedRuntime|selfUpdate|update(?:\.test)?\.ts|ForkCliInstall|tunnel(?:\.test)?\.ts|DesktopWsl|serviceLauncher|npm-launcher/,
    test: (o) =>
      o.token === "t3" &&
      (/["'`]t3["'`]/.test(o.line) || /forkCliArchive|fork-cli-release-assets/.test(o.path)),
  },
  {
    id: "kept-cli-artifacts",
    class: "kept",
    reason:
      "CLI release archive and executable names (t3-<version>-*, <runtime>/t3); forkCliArtifacts.ts publishes both names.",
    test: (o) => {
      // Anchored on the hit, so a runtime variable in the same token ($T3_RUNTIME_DIR/t3) still renames.
      const at = o.token.slice(o.offset);
      const prev = before(o);
      return (
        (/^t3-(?:\*|<version>|\$|\d+\\?\.\d+\\?\.\d+|\.\.\.|$)/.test(at) &&
          (/^[(/`.]?$/.test(prev) || afterEscape(o))) ||
        (/^t3(?:`?\)?\.?|[;:]|\\[rn].*)?$/.test(at) &&
          /^\/?$/.test(prev) &&
          !o.token.includes("://")) ||
        /^t3\\?\.exe/.test(at)
      );
    },
    path: /forkCliArtifacts|forkCliArchive|cliRelease|build-cli-archive|build-desktop-artifact|install\.(?:sh|ps1)|scripts\/install\.test\.ts|pinnedRuntime|selfUpdate|update(?:\.test)?\.ts|ForkCliInstall|tunnel(?:\.test)?\.ts|DesktopWsl|fork-cli-release-assets|serviceLauncher|smoke-cli|npm-launcher/,
  },
  {
    id: "upstream-repo-fields",
    class: "upstream-reference",
    reason:
      "Repository names in owner/name pairs, owner/t3code slugs and hosted remotes (pingdotgg/t3code, a fork's t3code repo), which the hosting provider owns, and upstream's t3tools owner.",
    test: (o) =>
      (o.token === "t3code" &&
        /\b(?:name|repo):\s*["']t3code["']/.test(o.line) &&
        (/\bowner:/.test(o.line) || /^\s*owner:\s*["'][^"']+["'],?$/.test(o.previousLine))) ||
      (o.token === "t3tools" && /\bowner:\s*["']t3tools["']/.test(o.line)) ||
      isRepositorySlugName(o) ||
      // An owner segment in a remote or slug (T3Tools/Platform, t3tools/t3code).
      (/^t3tools$/i.test(stem(o)) && o.token.includes("/") && !o.token.startsWith("@")) ||
      (o.token === "t3code" && /["'](?:path|name)=$/.test(o.line.slice(0, o.column))),
  },
  {
    id: "upstream-own-files",
    class: "upstream-reference",
    reason:
      "Files that speak for upstream: its security policy, which sends reports to ping.gg, and its trademark policy.",
    path: /^\.github\/SECURITY\.md$|^TRADEMARK\.md$/,
  },
  {
    id: "upstream-desktop-scheme",
    class: "upstream-reference",
    reason: "Upstream's desktop scheme, in tests that assert the fork rejects it.",
    path: /(?:promptLinks|providerAuthReturnUrl)\.test\.ts$/,
    token: /^t3code(?:-dev)?:\/\//,
  },
  {
    id: "upstream-pairing-app-link",
    class: "upstream-reference",
    reason:
      "Upstream's t3code://pair link; the fork builds and reads it from forkDesktopSchemes, as it does prompt links.",
    path: /^packages\/shared\/src\/remote\.ts$/,
    token: /^["'`]?t3code:\/\/pair\b/,
  },
  {
    id: "kept-upstream-identity-test",
    class: "kept",
    reason:
      "The test listing upstream's identity literals the fork must differ from, and the pre-Lathe names.",
    path: /^packages\/shared\/src\/forkIdentity\.test\.ts$/,
  },
  {
    id: "upstream-org-and-products",
    class: "upstream-reference",
    reason: "Upstream's company and sister products, and their published ids.",
    test: (o) =>
      (stem(o) === "T3" && /^T3 (?:Tools|Chat)\b/.test(o.line.slice(o.column))) ||
      (/t3tools\.com|T3Tools\.T3Code/.test(o.line) && /^(?:t3tools|T3Tools|T3Code)$/.test(stem(o))),
  },
  {
    id: "upstream-credit",
    class: "upstream-reference",
    reason:
      "Credit to upstream as the project the fork comes from (a fork of T3 Code, the makers of T3 Code).",
    test: (o) =>
      stem(o) === "T3" &&
      (/\b(?:fork|makers) of $/.test(o.line.slice(0, o.column)) ||
        (o.path === "docs/user/telemetry.md" && o.line.endsWith("usage events to T3"))),
  },
  {
    id: "upstream-replaced-identity-lines",
    class: "upstream-reference",
    reason:
      "Upstream lines the fork replaces with its identity values (FORK_IDENTITY); they reach the codemod only on the upstream-lathe mirror, which keeps them as upstream wrote them.",
    test: (o) =>
      UPSTREAM_REPLACED_IDENTITY_LINES.some(([path, line]) => o.path === path && line.test(o.line)),
  },
  {
    id: "kept-monogram-sample",
    class: "kept",
    reason: "Sample text for a grapheme-count test, not the product name.",
    path: /ProjectCommands\.test\.ts$/,
    line: /for \(const text of \["T3", "/,
  },
  {
    id: "kept-derived-monogram",
    class: "kept",
    reason: "A monogram the code derives from a project titled t3code, not the product name.",
    path: /projectIcon\.test\.ts$/,
    line: /\["t3code", "T3", /,
  },
  {
    id: "upstream-palette-search-samples",
    class: "upstream-reference",
    reason:
      "Palette search samples picked for their shape (a word with digits, two words run together) and the legacy t3code/ branch prefix the search still strips.",
    path: /^packages\/shared\/src\/paletteSearch(?:\.test)?\.ts$/,
  },
  {
    id: "upstream-text-match-samples",
    class: "upstream-reference",
    reason:
      "Sample text in the filesystem browse filter, speech hint and project monogram tests, picked for its length or for matching other samples; renaming some of it breaks the case.",
    path: /^packages\/(?:client-runtime\/src\/state\/filesystem|shared\/src\/speech)\.test\.ts$|^apps\/web\/src\/projectIconOptions\.test\.ts$/,
  },
  {
    id: "upstream-short-value-sample",
    class: "upstream-reference",
    reason:
      "The feedback scrubber's two-letter known value (t3), in rows that test that values under three characters are left alone; a longer name would be scrubbed and break the case.",
    path: /^apps\/server\/src\/feedback\/scrubFeedback\.test\.ts$/,
    line: /failed for t3\b|^\s*\["t3"|two-letter username such as t3/,
  },
  {
    id: "kept-upstream-alpha-dir",
    class: "kept",
    reason:
      "Upstream's pre-release user data directory name, T3 Code (Alpha), read as a migration source.",
    test: (o) => o.line.slice(o.column).startsWith("T3 Code (Alpha)"),
  },
  {
    id: "upstream-project-sync-source",
    class: "upstream-reference",
    reason:
      "Project sync imports from upstream T3 Code's home (~/.t3 by default), so its text names upstream.",
    test: (o) =>
      stem(o) === "T3" &&
      /^T3(?:\s|'s|$)/.test(o.line.slice(o.column)) &&
      (/projectSync\/|ProjectSync|ProjectsSettings\.|SyncedConversation\./.test(o.path) ||
        /synced from T3 Code/.test(o.line) ||
        (/\/i18n\/translations\/[A-Za-z-]+\.json$/.test(o.path) &&
          /another T3 install/.test(o.line)) ||
        (/\/Sidebar(?:ThreadRow)?\.tsx$/.test(o.path) && /^\s*T3\s*$/.test(o.line))),
  },

  // agent-facing: names agents see and address
  {
    id: "agent-mcp-alias-list-widening",
    class: "agent-facing",
    reason:
      "The first entry of a multi-line MCP server alias list gains lathe before it; the pre-Lathe spellings stay for stored tool names.",
    test: (o) =>
      /_SERVER_ALIASES = new Set\(\[$/.test(o.previousLine) && /^\s*"t3-code",$/.test(o.line),
    rewrite: () => ({ length: "t3-code".length, text: 'lathe",\n  "t3-code' }),
  },
  {
    id: "kept-mcp-alias-list",
    class: "kept",
    reason:
      "Pre-Lathe spellings in a multi-line MCP server alias list, which stored tool names use.",
    test: (o) =>
      /^\s*"t3(?:-code|_code|code)",$/.test(o.line) &&
      /_SERVER_ALIASES = new Set\(\[$|^\s*"(?:lathe|t3-code|t3_code)",$/.test(o.previousLine),
  },
  {
    id: "agent-mcp-direct-matcher",
    class: "agent-facing",
    reason:
      "The matcher for Codex's direct-only MCP server, which the fork registers as lathe-direct; no stored name uses the old spelling.",
    test: (o) => o.line.slice(o.column).startsWith("t3[-_]code[-_]direct"),
    rewrite: () => ({ length: "t3[-_]code[-_]direct".length, text: "lathe[-_]direct" }),
  },
  {
    id: "agent-mcp-matcher-widening",
    class: "agent-facing",
    reason:
      "Matchers for the MCP server name, widened to accept lathe beside the pre-Lathe spellings (t3-code, t3_code, t3code) that stored tool names keep.",
    test: (o) => mcpMatcherWidening(o) !== undefined,
    rewrite: (o) => {
      const widening = mcpMatcherWidening(o)!;
      return { length: widening.from.length, text: widening.to };
    },
  },
  {
    id: "kept-mcp-legacy-matchers",
    class: "kept",
    reason:
      "Matchers for the MCP server's pre-Lathe spellings (t3-code, t3_code, t3code) in stored tool names and provider events; the fork's compat adds lathe beside them.",
    test: (o) => {
      const rest = o.line.slice(o.column);
      return (
        rest.startsWith("t3[-_ ]?code") ||
        rest.startsWith("t3[-_]?code") ||
        rest.startsWith("t3_?code") ||
        (/t3-code\|t3_code\|t3code/.test(o.line) && /^t3(?:-code|_code|code)[|)]/.test(rest)) ||
        (/_SERVER_ALIASES = new Set\(/.test(o.line) && /^t3(?:-code|_code|code)["'`]/.test(rest))
      );
    },
  },
  {
    id: "kept-pi-legacy-canonical-tools",
    class: "kept",
    reason:
      "Pi's hidden canonical tool names (mcp__t3_code__*), which reserve ownership against Pi's configured MCP servers and keep pre-rename tool names resolvable; the public names become mcp__lathe__*.",
    path: /provider-pi\/src\/server\/mcpExtensionSource(?:\.test)?\.ts$/,
    token: /mcp__t3_code__/,
  },
  {
    id: "agent-mcp-names",
    class: "agent-facing",
    reason:
      "MCP server name (t3-code) and tool names (t3_*) agents call. Renamed to lathe and lathe_*; the old names stay recognised permanently, since stored tool calls and provider transcripts hold them.",
    token:
      /mcp__t3[-_]code__|(?:^|[^A-Za-z0-9])t3_(?:workflow|thread|preview|worktree|device|project|environment|pending|queue|attachment|html|orchestrator|scheduled|delegate|task|document|link|unwatch|watch|find|read|create|list|request|resolve|background|theme|feedback|submit)[a-z_]*|^["'`]?t3-code["'`:]?$|^t3-code-\*|^mcp_servers\.t3-code$/,
  },
  {
    id: "agent-mcp-matchers",
    class: "agent-facing",
    reason:
      "Matchers that recognise the MCP server under its spellings (t3-code, t3_code, t3code) in stored tool names.",
    line: /t3\[-_ \]\?code|t3-code MCP|\(t3\[-_ ]|t3-code\|t3_code\|t3code|T3_MCP_SERVER_ALIASES/,
  },
  {
    id: "agent-mcp-spellings",
    class: "agent-facing",
    reason:
      "The MCP server name in tool ids, matchers and setup commands (t3-code.x, _t3-code, claude mcp add ... t3), and ACP extension methods (_t3/...).",
    test: (o) =>
      /t3-code[./\\$-]|_t3-code|t3-code\/|^_t3\//.test(o.token) ||
      (/mcp add/.test(o.line) && /^t3$/.test(o.token)),
  },
  {
    id: "agent-prompt-tags",
    class: "agent-facing",
    reason: "Prompt markup agents read (<t3_context>, t3_code_instructions).",
    token: /t3_context|t3_code_[a-z_]*|(?:^|[^A-Za-z])t3_code(?:$|[^a-z_])/,
  },

  {
    id: "agent-mcp-app-setup-name",
    class: "agent-facing",
    reason:
      "The name the setup steps give the MCP server in another agent app (hermes or openclaw mcp add/login t3code, t3code under mcp_servers); it becomes lathe, as claude mcp add does.",
    test: (o) =>
      /^t3code[.,]?$/.test(o.token) &&
      /\b(?:hermes|openclaw) mcp (?:add|login) t3code|\bmcp_servers\b/.test(o.line),
  },

  // identifiers: names that never leave the build
  {
    id: "upstream-fixture-repo-search",
    class: "upstream-reference",
    reason:
      "A test's search query for the t3code fixture project, which upstream-fixture-repo-names keeps.",
    path: /(?:\.test\.[cm]?[jt]sx?)$/,
    test: (o) =>
      o.token === "t3" && /\bsearch\(\s*["'`]t3["'`]/.test(o.line) && /t3code/.test(o.line),
  },
  {
    id: "id-desktop-relaunch-app-links",
    class: "identifier",
    reason:
      "App links the relaunch test expects stripped; they must use the app's own scheme, which the fork renames.",
    path: /^apps\/desktop\/src\/app\/DesktopLifecycle\.test\.ts$/,
    token: /^t3code:\/\//i,
  },
  {
    id: "upstream-fixture-repo-names",
    class: "upstream-reference",
    reason:
      "Test data naming the t3code repository or its t3tools owner, which tests compare with kept repository names; left as upstream wrote it. Replay transcripts follow the renamed code instead.",
    path: /(?:\.test\.[cm]?[jt]sx?|\.testkit\.ts|__snapshots__\/.*|\.snap)$|\/testkit\/(?!.*\.ndjson$)/,
    test: (o) =>
      /^t3(?:code|tools)$/i.test(stem(o)) &&
      // A camelCase field (t3Tools) is a code symbol, which follows the renamed code.
      !/^t3[A-Z]/.test(stem(o)) &&
      // Values tests compare with renamed code: attribution, user agents, DISPLAY,
      // lint rule names, command-line flags, systemd unit names, storage keys, DOM
      // attributes and the preview's certificate approvals file.
      !/attribution|user-?agent|userAgent|DISPLAY/i.test(o.line) &&
      !/\.slice\b|-protect\.conf|^["'`]?t3code:[a-z]|t3code\/compile-cache|^data-t3code-|t3code-(?:certificate-approvals|backend-recovery)/.test(
        o.token,
      ) &&
      !/^t3code\/no-/.test(o.token.slice(o.offset)) &&
      // Windows task names, which serviceTaskName renames.
      !/^t3code-PC-/.test(o.token.slice(o.offset)) &&
      !o.token.startsWith("--") &&
      !/^oxlint-plugin-/.test(o.path),
  },
  {
    id: "id-css-names",
    class: "identifier",
    reason: "CSS classes and custom properties (font-t3-*, --t3-*).",
    token:
      /(?:^|[^A-Za-z])font-t3-|--t3-|t3-file-icon-|t3-(?:assistant-citation|thread-find|document-comment)/,
  },
  {
    id: "id-lint-plugin",
    class: "identifier",
    reason:
      "The repo's oxlint plugin and rule names (t3code/no-*), also where a rule matches its own name in a regex (t3code\\/rule\\s).",
    token: /^t3code(?:\/|\\\/)[a-z-]+(?:\\s)?$/,
  },
  {
    id: "id-internal-env",
    class: "identifier",
    reason: "T3_* variables our own processes pass to each other or to tests, never set by a user.",
    test: (o) => /^T3_[A-Z0-9_]/.test(o.token.slice(o.offset)) && !/[A-Za-z0-9]/.test(before(o)),
  },
  {
    id: "id-camel-symbol",
    class: "identifier",
    reason: "camelCase or PascalCase code symbol (T3ComposerEditorView, allT3, t3Home).",
    test: (o) => /[a-z]T3|T3[A-Z][a-z]|^t3[A-Z][a-z]|[A-Z]T3[A-Z][a-z]/.test(stem(o)),
  },

  {
    id: "upstream-service-name-wrapped",
    class: "upstream-reference",
    reason:
      "Prose wrapped between T3 and an upstream service name (T3 / Connect), which upstream-service-names keeps on one line.",
    test: (o) =>
      o.token === "T3" &&
      o.line.trimEnd().length === o.column + 2 &&
      /^\s*(?:Connect|Chat|Tools|account|services)\b/.test(o.nextLine),
  },

  // display: text a person reads
  {
    id: "display-product-name",
    class: "display",
    reason: 'The product name "T3 Code" in UI strings, docs and comments.',
    test: (o) => o.token.slice(o.offset) === "T3" && / ?T3 Code\b/.test(o.line),
  },
  {
    id: "display-short-name",
    class: "display",
    reason: 'The short product name in prose: "T3 thread", "T3 home", "T3-owned".',
    test: (o) =>
      /^T3(?:-(?:owned|managed|Code|code))?[.,:;)'"]*$/.test(o.token) &&
      !/T3 (?:Connect|Tools|Chat)\b/.test(o.line),
  },

  // area defaults: whole areas whose remaining names share one answer
  {
    id: "kept-repo-slug",
    class: "kept",
    reason:
      "The current and former Lathe GitHub repo slugs are used by installers, updaters and npm publishing.",
    token: /(?:latheworks|jamesainslie)\/t3code/,
  },
  {
    id: "wire-relay-package",
    class: "wire-peer",
    reason: "The relay workspace package (t3code-relay), part of upstream's relay source.",
    token: /^["'`]?(?:--filter[= ])?t3code-relay\b/,
  },
  {
    id: "id-temp-and-ci-names",
    class: "identifier",
    reason:
      "Temp directory prefixes, CI temp files and keychains, dev-container volumes, and comment markers; nothing reads them across versions.",
    test: (o) =>
      /^["'`(]?t3(?:code)?-[a-z0-9-]*-["'`]?\)?,?$|t3(?:code)?-[a-z0-9-]+-\$\{|t3code-(?:pnpm-store|node-modules|transfer-budget|android-|marketing)|t3-cli-signing|t3code\.provisionprofile|<!-- t3-|\.t3-refresh$/.test(
        o.token,
      ) ||
      (o.path.startsWith(".github/") && !/com\.t3tools/.test(o.token)),
  },
  {
    id: "id-dev-and-host-names",
    class: "identifier",
    reason:
      "Dev replay names (agentInfo, window.t3dev, the t3/mcp_call request), test origins, secret separators, the agents' systemd slice and protection drop-in; Lathe names them for itself so it never shares them with upstream on one host.",
    token:
      /t3-dev-replay|t3\/mcp_call|(?:^|\.)t3dev\b|t3-boot\.test|__t3-secret-|app-t3code\.slice|90-t3code-protect\.conf/,
  },
  {
    id: "id-eval-and-native-fixtures",
    class: "identifier",
    reason:
      "Locals and prompt text in the MCP tool-use evals, and the Hyprland window event in the snap-shot helper's tests.",
    test: (o) =>
      (o.path === "evals/mcp-tool-use/run.ts" &&
        /^(?:\.\.\.)?(?:base\.)?t3(?:\.map|\.filter)?,?$/.test(o.token)) ||
      (o.path === "evals/mcp-tool-use/secret-grading.ts" && /^`?T3SECRET`?$/.test(o.token)) ||
      (o.path === "evals/mcp-tool-use/devices.ts" && /^T3\\`?$/.test(o.token)) ||
      (o.path.startsWith("native/hyprland-snap-shot/") && /openwindow>>/.test(o.line)),
  },
  {
    id: "id-desktop-internals",
    class: "identifier",
    reason:
      "Desktop internals rebuilt with the app: dev flags, build keys, Windows shim locals and types, CDP ids, icon files, the compile cache, the preview's certificate approvals file, the backend recovery directory, FFI library labels, and the AppImage mount prefix (named after the artifact).",
    token:
      /--t3code-dev-root|t3code-(?:certificate-approvals|backend-recovery)|\.mount_T3-|t3code(?:CommitHash|WebAuthn)|t3_(?:codepage|exit)|T3\.Env|t3-(?:kernel32|user32|preview|black-windows|electron|macos-process-identity)|^["'`]t3code["'`],?$/,
    path: /^apps\/desktop\/|^scripts\/|\.vscode\//,
  },
  {
    id: "id-compile-cache",
    class: "identifier",
    reason:
      "The desktop compile cache directory, a throwaway cache (shared with upstream, so the old one is not deleted).",
    test: (o) =>
      (o.token === "t3code" && /compile-cache/.test(o.line)) ||
      /(?:^|\/)t3code\/compile-cache/.test(o.token),
  },
  {
    id: "id-transient-storage",
    class: "identifier",
    reason: "Storage keys and events that are transient or caches: renaming only clears them.",
    token:
      /t3code:(?:open-command-palette|preview-action|focus-composer|local_storage_change|github-routing-changed|update-everything-result|snap-shot-setup-resume|chunk-load-reloaded|dev-compression|project-favicons)|t3\.pullRequests\.(?:detail|list|recentDetails)|t3-acp-registry-icons|t3:(?:paste-as-text|thread-find-open|thread-find-query|guest-awaiting-rows)|t3-thread-context-drop|\.\{t3,lathe,t3f\}/,
  },
  {
    id: "id-guest-session-cookie",
    class: "identifier",
    reason:
      "Guest share session cookies (t3_guest_<share id>). Cookies ignore the port, so the rename keeps Lathe and upstream on one host from sharing them; a lost cookie only makes a guest open the link again.",
    token: /t3_guest_\$/,
  },
  {
    id: "id-readable-syntax-theme",
    class: "identifier",
    reason:
      "The name of the generated readable light syntax theme, passed to the diff workers; nothing stores it.",
    token: /(?:^|[^A-Za-z0-9-])t3-light(?:$|[^A-Za-z0-9-])/,
  },
  {
    id: "id-effect-service-tags",
    class: "identifier",
    reason: "Effect service and context tag keys (t3/auth/SessionStore); in-process only.",
    test: (o) =>
      /^["'`]?t3\/[A-Za-z]/.test(o.token.slice(Math.max(0, o.offset - 1))) &&
      /\)\(\s*["'`]t3\/|Context\.|Service|Tag|^\s*["'`]t3\/[A-Za-z/]+["'`],?\s*$/.test(o.line),
  },
  {
    id: "id-shell-helpers",
    class: "identifier",
    reason:
      "Shell and script helper functions and locals (t3_home, t3_runtime_ready, script_t3, first_t3) inside generated scripts.",
    token: /^\/?\$?t3_(?:home|runtime_ready|fetch|cwd)$|^\$?(?:script|version|first)_t3$/,
  },
  {
    id: "id-metric-names",
    class: "identifier",
    reason:
      "OpenTelemetry metric names (t3_*_total); renaming them means updating any dashboard that queries them.",
    token: /^`?t3_[a-z_]+_(?:total|duration|wait|delay|max|bytes|utilization|percent|count)`?$/,
  },
  {
    id: "id-runtime-ids-and-prefixes",
    class: "identifier",
    reason:
      "Runtime ids, temp and socket prefixes, log tags, MIME types, CSS transition and highlight names, FFI library labels, AudioWorklet and IPC message names, headers between the server and its own provider sessions, asset files and test identities; nothing reads them across versions.",
    test: (o) =>
      /t3(?:code)?-\$|t3_\$|t3-(?:cli|token|math|bench-gone)-\$|t3-desktop-readiness|^t3-claude$|t3code-startup-warmup|t3-(?:host|mermaid|term|orchestrator-v2|preview|ghostty-input|permission-check|acp-cli|acp-mock|collab-mock|pi-mcp|markdown-inline-prefix|mobile-|draft-hero|snap-shot|agent|black-|iris|checkpoint-index|kde-bus|browser-launch|darwin|advapi32|kernel32|libsystem|pcm-capture|cut-line-note|speech-reply|tool-exposure|service-tier|prompt-\$|create-\$)|tmp_objdir-t3(?:code)?-|__t3codeStartupModuleProfiler|t3code-(?:desktop|git-trace2|review-index|ssh-askpass|pierre)|\.t3-(?:capture|icon-export|replaced-|rule-copies\.json|setup-)|\/\.t3\.X{6}|t3_capture_|t3ssh-|\/tmp\/t3-|x-t3code-|t3continue-|t3-xai-prompt-|msg_t3_|refs\/t3code\/|\.cache\/t3code\/|^t3\.export\.|^\[t3-|^t3:jsonrpc|\$t3:|t3code_no_provider|t3_dev_session_|noreply@t3\.codes|t3code@users\.noreply|t3code-test@|-t3\.\d+|dist-exe\/t3|npm-launcher\/t3\.mjs|release\/t3-|\/t3\.tgz|^\/t3\/$|\.\{t3,lathe,t3f\}|\\\.t3\b|t3\/[a-z0-9-]+\/[A-Z]|^\/?t3-connect$|^\[t3-|^["'`]t3\/orchestration-v2\/|t3-page\.localhost|t3-sqlite-state|not-a-t3-server|app-t3code-agents/.test(
        o.token,
      ) ||
      (/^t3[.:]?$/.test(o.token) &&
        /otelEnvironment|provider-pi\/src\/server\/adapter|build-cli-archive/.test(o.path)) ||
      // systemd scope units the server creates and later finds by prefix.
      (o.token === "t3code-" && /process\/agentScope/.test(o.path)) ||
      (/^\/?\.t3\.?$/.test(o.token) && o.path.startsWith("scripts/seed-issue-")) ||
      (/^["'`]?t3code["'`]?,?$/.test(o.token) &&
        /user-agent|DISPLAY|attribution|oxlint-plugin-t3code|name: "t3code"/.test(o.line)),
  },
  {
    id: "display-ui-placeholder",
    class: "display",
    reason: "UI placeholder text naming a t3 directory.",
    token: /\.codex-t3/,
  },
  {
    id: "id-oxlint-plugin-package",
    class: "identifier",
    reason: "The repo's oxlint plugin package name.",
    token: /oxlint-plugin-t3code/,
  },
  {
    id: "display-cli-version-spec",
    class: "display",
    reason:
      "The CLI shown as t3@<version> in status and update messages; the fork's package is @jamesainslie/lathe.",
    token: /(?:^|[^A-Za-z0-9])t3@/,
  },
  {
    id: "display-artifact-name",
    class: "display",
    reason:
      "Upstream's desktop artifact base name (T3-Code-<version>); the fork names artifacts after FORK_IDENTITY.artifactBaseName.",
    token: /T3-Code-/,
  },
  {
    id: "id-internal-literals",
    class: "identifier",
    reason:
      "In-process literals: Pi event types, the ACP unknown-update tag, settings search ids, placeholder hosts, the worktree .t3 dev directory.",
    test: (o) =>
      /^["'`]?t3\.[a-z_]+["'`]?,?$|_t3_unknown|t3\.invalid|pi-t3-mcp|t3-tree-/.test(o.token) ||
      (/(?:^|[/"'`$ ])\.t3(?:$|[/"'`])/.test(o.token) && !/\.mdx?$/.test(o.path)),
  },
  {
    id: "upstream-service-names",
    class: "upstream-reference",
    reason: "Upstream's services and accounts named in prose: T3 Connect, T3 account, T3 services.",
    test: (o) =>
      /^T3$/.test(stem(o)) && /T3 (?:Connect|account|services|Environment|App)\b/.test(o.line),
  },
  {
    id: "upstream-links-and-router",
    class: "upstream-reference",
    reason:
      "Links to upstream's site and legal pages, T3 Chat, upstream's web channel router, a vendored dependency's upstream branch, and upstream's own release workflow.",
    test: (o) =>
      /^https:\/\/t3\.(?:codes|chat)(?:\/[a-z-]+(?:\.sh|\.ps1)?)?\/?(?:$|\\)|t3code_web_channel|__t3code\/channel|tree\/t3code\//.test(
        o.token,
      ) || o.path === ".github/workflows/release.yml",
  },
  {
    id: "id-workspace-package-t3",
    class: "identifier",
    reason:
      "The server workspace package is named t3 (--filter t3, t3#build); renamed with the package.",
    line: /--filter[ =]['"]?!?t3\b|t3#[a-z]|"name": "t3"|filter=t3\.\.\./,
  },
  {
    id: "display-cli-command",
    class: "display",
    reason:
      "The CLI command in help text, errors and docs (`t3 serve`, `npx t3`); the fork's CLI is lathe.",
    test: (o) =>
      /^t3$/.test(stem(o)) &&
      /(?:^|[`'"( >])(?:npx |pnpm dlx |bunx )?t3(?: [a-z%][a-z-]*| CLI\b| --?[a-z]|`|'|"|\)|<|\\|$)/.test(
        o.line,
      ),
  },
  {
    id: "upstream-translated-service-compounds",
    class: "upstream-reference",
    reason:
      "T3 Connect and T3 Chat compounds in translation catalogs (T3-Connect-Konto, T3-Chat-Abo), upstream's services, kept as upstream-service-names keeps the English.",
    path: /^apps\/[a-z]+\/src\/i18n\/translations\/[A-Za-z-]+\.json$/,
    token: /^T3-(?:Connect|Chat)-/,
  },
  {
    id: "display-translated-short-name",
    class: "display",
    reason:
      "The product and its CLI in translation catalogs, following the English source of the same key: T3-Thread, T3-trådar, T3:s, T3-Home, t3-Befehl, t3/add-search.",
    path: /^apps\/[a-z]+\/src\/i18n\/translations\/[A-Za-z-]+\.json$/,
    test: (o) =>
      (stem(o) === "T3" && /^T3(?:[-:][A-Za-z-]*)?[.,:;]?$/.test(o.token)) ||
      (stem(o) === "t3" && /^t3(?:\/(?:add-search)?|-Befehls?)?[.,:;]?$/.test(o.token)),
  },
  {
    id: "display-short-name-after-escape",
    class: "display",
    reason: 'The short product name after a newline escape in a string ("Created\\nT3 threads").',
    test: (o) => stem(o) === "T3" && afterEscape(o) && /^T3 thread/.test(o.line.slice(o.column)),
  },
  {
    id: "display-cli-install-messages",
    class: "display",
    reason:
      "The CLI named in install and uninstall messages where punctuation or a value follows it (t3., t3:, t3 <version>).",
    path: /^apps\/server\/src\/cli\/(?:install|uninstall)\.ts$/,
    test: (o) => stem(o) === "t3" && /^t3[.:]?$/.test(o.token),
  },
  {
    id: "id-binaries-and-scripts",
    class: "identifier",
    reason:
      "Bundled helper binaries, shell functions, DOM data attributes, generated id prefixes, and the MCP client names the CLI sends to its own server.",
    token:
      /t3-resource-monitor|t3-browser-secret|t3-apple-speech|t3_fetch|\$__t3c|__t3(?:_command|[cf])(?![A-Za-z0-9_])|data-t3code-|data-t3-context|t3_\$\{|run-t3|t3-runtime|\.notarize-t3|t3-cli-archive|t3-screens|^t3-[a-z]+-cli$/,
  },
  {
    id: "kept-vcs-config-file",
    class: "kept",
    reason: ".t3code/vcs.json read from users' repos, shared with upstream users.",
    test: (o) => o.token === ".t3code" && /vcs\.json/.test(o.line),
  },
  {
    id: "kept-dev-data-scripts",
    class: "kept",
    reason: "The dev-data scripts read upstream's ~/.t3 install.",
    path: /migrate-dev-db|(?:t3|lathe)-sqlite-state/,
    token: /^\.t3\.?$/,
  },
  {
    id: "id-small-internals",
    class: "identifier",
    reason:
      "Log tags, the derived message attribution, watcher globs, a replay checkout path and the repo's own skill names.",
    test: (o) =>
      /\[t3-cloud\]|\.\{t3,lathe,t3f\}|replay-user\/t3code|test-t3-(?:app|mobile)/.test(o.line) ||
      (o.token === "t3code" && o.path.endsWith("userMessage.ts")),
  },
  {
    id: "upstream-named-in-comments",
    class: "upstream-reference",
    reason: "Comments that name upstream's or pre-rename forms on purpose.",
    test: (o) =>
      /^\s*(?:\/\/|\*|\/\*\*?|#)/.test(o.line) &&
      /upstream|pre-rename|before the Lathe rename|legacy|V1 profiles/i.test(o.line),
  },
  {
    id: "id-markdown-insight-marker",
    class: "identifier",
    reason:
      "The private alert marker the markdown renderer writes and reads back within one render; it stays upper case like the alert names beside it.",
    token: /T3-INSIGHT-/,
    rewrite: () => ({ length: 2, text: "LATHE" }),
  },
  {
    id: "id-local-bindings",
    class: "identifier",
    reason:
      "Locals named t3 (the resolved tool name in the feedback trace, the workflow API's rest binding) and the CLI's process name in the bench's competing-process matcher.",
    test: (o) =>
      (/^(?:\.\.\.)?t3$/.test(o.token) &&
        /^apps\/server\/src\/(?:feedback\/FeedbackTrace|workflows\/WorkflowRuntime)\.ts$/.test(
          o.path,
        )) ||
      (o.token === "t3" && o.path === "scripts/server-metrics.ts" && /COMPETING/.test(o.line)),
  },
  {
    id: "display-workflow-api",
    class: "display",
    reason:
      "The workflow API as a workflow file calls it (T3.workflow, T3.step): the injected global is the short product name, so messages and examples follow it.",
    token: /^["'`(]*T3\.[A-Za-z]+/,
  },
  {
    id: "display-bench-report-processes",
    class: "display",
    reason: "The server's processes named in the bench report's load warning (node/T3/agent).",
    token: /^node\/T3\/agent$/,
  },
  {
    id: "upstream-bench-commit-author",
    class: "upstream-reference",
    reason:
      "The throwaway author address the bench scripts give git for commits in temp repositories; it names upstream's domain and nothing reads it.",
    token: /^["'`]?bench@t3\.codes/,
  },
  {
    id: "id-comments",
    class: "identifier",
    reason: "Other comments; they follow the code they describe.",
    line: /^\s*(?:\/\/|\*|\/\*\*?|#)/,
  },
  {
    id: "display-docs-prose",
    class: "display",
    reason: "Remaining mentions in documentation and agent skill prose.",
    path: /\.mdx?$/,
  },

  // test fixtures: recorded transcripts, example paths and ids
  {
    id: "id-test-fixture",
    class: "identifier",
    reason:
      "Test data: replay transcripts, example paths, temp prefixes, ids. Follows the code it tests.",
    path: /(?:\.test\.[cm]?[jt]sx?|\.testkit\.ts|\/testkit\/|\/fixtures\/|__snapshots__\/.*|\.snap|\.ndjson)$|\/testkit\/|\/fixtures\//,
  },
  // Last, so it only sees what nothing above classifies.
  {
    id: "upstream-replaced-identity",
    class: "upstream-reference",
    reason:
      "Upstream's own app ids, schemes, service and package names in lines the fork replaced with FORK_IDENTITY. Only the upstream-lathe mirror holds them, and keeps them as upstream wrote them.",
    test: (o) =>
      UPSTREAM_IDENTITY_TOKEN.test(o.token) ||
      (UPSTREAM_CLI_FILES.test(o.path) &&
        /(?:^|\/)t3(?::|\\?\.mjs|\$\/)?$|^t3\$reset\.?$|\\nt3$/.test(o.token)),
  },
];

export const ruleHelpers = { before, afterEscape, stem };
