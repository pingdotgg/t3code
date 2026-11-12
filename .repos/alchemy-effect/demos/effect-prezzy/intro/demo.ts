/**
 * The live demo: building Shorty the way an agent would. Every entry is one
 * keypress and one change; code is cut from the type-checked app in
 * `snippets/shorty/`, terminal output is written out here, and the browser
 * shows screenshots from `assets/`.
 */
import type { StepSpec } from "./steps.ts";

// Terminal colours, matching the CLI.
const T = {
  ok: "\x1b[38;5;113m",
  bad: "\x1b[38;5;203m",
  soft: "\x1b[38;5;150m",
  accent: "\x1b[38;5;173m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};
const $ = (cmd: string) => `${T.dim}$${T.reset} ${cmd}`;
const TABS = ["agent", "dev", "test"];

/** A terminal step whose last `fresh` lines are new. */
const term = (s: {
  title: string;
  notes: string;
  lines: string[];
  fresh?: number;
  tab?: number;
  group?: string;
}): StepSpec => ({
  kind: "terminal",
  title: s.title,
  notes: s.notes,
  group: s.group ?? `term-${s.tab ?? 0}`,
  tabs: TABS,
  active: s.tab ?? 0,
  lines: s.lines.join("\n"),
  fresh: s.fresh,
});

/** A code step from the Shorty app: `file` is the label, `regions` what's shown. */
const code = (s: {
  title: string;
  notes: string;
  file: string;
  snippet: string;
  regions?: string[];
  /** Regions not written yet at this step. */
  omit?: string[];
  marks?: Extract<StepSpec, { kind: "code" }>["marks"];
  error?: Extract<StepSpec, { kind: "code" }>["error"];
  group?: string;
}): StepSpec => ({
  kind: "code",
  group: s.group ?? `demo-${s.file}`,
  file: s.file,
  title: s.title,
  src: { snippet: `shorty/${s.snippet}`, regions: s.regions ?? ["show"], omit: s.omit },
  marks: s.marks,
  error: s.error,
  notes: s.notes,
});

const TSC_ERROR = [
  $("tsc --noEmit"),
  `${T.bad}src/Api.ts:22:44${T.reset} - ${T.bad}error${T.reset} TS2322:`,
  `  Type 'LinkStoreError' is not assignable to type 'never'.`,
  ``,
  `${T.dim}Found 1 error.${T.reset}`,
];
const TSC_OK = [$("tsc --noEmit"), `${T.ok}✓${T.reset} no errors`];
const TEST_START = [$("bun test"), `${T.dim}deploying Shorty to a local stage…${T.reset}`];
const TEST_OK = [
  `${T.ok}✓${T.reset} creates and reads back a link ${T.dim}(38ms)${T.reset}`,
  `${T.ok}✓${T.reset} a missing link is a typed LinkNotFound ${T.dim}(9ms)${T.reset}`,
  `${T.ok}✓${T.reset} lists every link ${T.dim}(12ms)${T.reset}`,
  ``,
  `${T.ok}3 pass${T.reset} ${T.dim}· 0 fail · 1.4s${T.reset}`,
];
const DEV = [
  $("alchemy dev"),
  `${T.ok}✓${T.reset} Api ${T.dim}(Cloudflare.Worker)${T.reset}    http://localhost:1337`,
  `${T.ok}✓${T.reset} Db  ${T.dim}(Cloudflare.D1.Database)${T.reset} local`,
];
const DEV_WEB = [
  ...DEV,
  `${T.ok}✓${T.reset} Web ${T.dim}(Cloudflare.Website)${T.reset}   http://localhost:5173`,
];
const PLAN = [
  $("alchemy deploy --stage prod"),
  `${T.ok}✓${T.reset} Plan ready ${T.dim}(0.9s)${T.reset}`,
  ``,
  `${T.accent}${T.bold}Deploy${T.reset}${T.dim} · ${T.reset}${T.ok}4 to create${T.reset}`,
  `${T.ok}+${T.reset} ${T.bold}Postgres${T.reset} ${T.dim}(Neon.Project)${T.reset}`,
  `${T.ok}+${T.reset} ${T.bold}Pool${T.reset} ${T.dim}(Cloudflare.Hyperdrive)${T.reset}`,
  `${T.ok}+${T.reset} ${T.bold}Api${T.reset} ${T.dim}(Cloudflare.Worker)${T.reset}`,
  `  ${T.ok}+${T.reset} ${T.soft}Pool${T.reset}`,
  `${T.ok}+${T.reset} ${T.bold}Web${T.reset} ${T.dim}(Cloudflare.Website)${T.reset}`,
  ``,
  `${T.bold}Deploy?${T.reset}  ${T.accent}${T.bold}› Deploy${T.reset}  ${T.dim}Cancel${T.reset}`,
];
const APPLIED = [
  $("alchemy deploy --stage prod"),
  `${T.ok}✓${T.reset} Postgres ${T.dim}(Neon.Project)${T.reset} created ${T.dim}(4.1s)${T.reset}`,
  `${T.ok}✓${T.reset} Pool ${T.dim}(Cloudflare.Hyperdrive)${T.reset} created ${T.dim}(1.3s)${T.reset}`,
  `${T.ok}✓${T.reset} Api ${T.dim}(Cloudflare.Worker)${T.reset} created ${T.dim}(5.8s)${T.reset}`,
  `${T.ok}✓${T.reset} Web ${T.dim}(Cloudflare.Website)${T.reset} created ${T.dim}(7.2s)${T.reset}`,
  ``,
  `${T.ok}Stack deployed (4/4)${T.reset}`,
  `${T.dim}web:${T.reset} https://shorty-web-prod.workers.dev`,
];

/** A chain of steps building one file up: each entry omits the regions not written yet. */
const chain = (
  base: { file: string; snippet: string; group?: string; regions?: string[] },
  steps: {
    title: string;
    notes: string;
    omit?: string[];
    snippet?: string;
    marks?: Extract<StepSpec, { kind: "code" }>["marks"];
    error?: Extract<StepSpec, { kind: "code" }>["error"];
  }[],
): StepSpec[] => steps.map((s) => code({ ...base, ...s, snippet: s.snippet ?? base.snippet }));

const LINK = { file: "src/Link.ts", snippet: "Link.ts" };
const API_SCHEMA = { file: "src/ShortyApi.ts", snippet: "ShortyApi.ts" };
const LINKS = {
  file: "src/Links.ts",
  snippet: "Links.ts",
  group: "demo-links",
  regions: ["service"],
};
const WORKER = { file: "src/Api.ts", snippet: "ApiDraft.error.ts", group: "demo-api" };
const TEST = { file: "test/api.test.ts", snippet: "api.test.ts" };
const STACK = { file: "alchemy.run.ts", snippet: "StackWeb.ts", group: "demo-stack" };
const NEON = { file: "src/Storage.ts", snippet: "Storage.ts", regions: ["neon"] };

export const demo: StepSpec[] = [
  {
    kind: "slide",
    layout: "section",
    title: "Let's build something",
    eyebrow: "Demo",
    heading: "Let's build something",
    subtitle: "A link shortener, built the way an agent would",
    notes:
      "Let's build Shorty, a link shortener, the way you'd build it with an agent: API first, types and tests on every change, then a website, then production.",
  },

  // 1. The data
  ...chain(LINK, [
    {
      title: "Start with the data, a Link",
      omit: ["notFound"],
      notes:
        "Everything starts from the schema. A Link is a short code, the URL it points to, and when it was created.",
    },
    {
      title: "A missing link is a typed error",
      omit: ["status"],
      notes:
        "What happens when a code doesn't exist? That's LinkNotFound: a real error type, not a null.",
    },
    {
      title: "…that becomes a 404 over HTTP",
      notes: "One annotation, and the same error is a 404 when it crosses HTTP.",
    },
  ]),

  // 2. The API, as a schema
  ...chain(API_SCHEMA, [
    {
      title: "The first endpoint creates a link",
      omit: ["get", "list", "api"],
      notes: "Now the API. POST /links takes a URL and returns a Link.",
    },
    {
      title: "Then one to get a link by its code",
      omit: ["getError", "list", "api"],
      notes: "GET /links/:code returns the Link…",
    },
    {
      title: "…which can fail with LinkNotFound",
      omit: ["list", "api"],
      notes: "…or LinkNotFound, which is now part of the contract.",
    },
    { title: "And one to list every link", omit: ["api"], notes: "And GET /links lists them all." },
    {
      title: "Together they're one API, as a value",
      notes:
        "ShortyApi is a value. The Worker will serve it, and the tests and the website will call it with a client derived from it.",
    },
  ]),

  // 3. Storage, as a service
  ...chain(LINKS, [
    {
      title: "Storage is a service, so the API never names a database",
      omit: ["storeError", "get", "list"],
      notes:
        "Links is an interface: create a link. The Worker will depend on this, never on a database.",
    },
    {
      title: "It can also get and list links",
      omit: ["storeError"],
      notes: "Get one by code, and list them all.",
    },
    {
      title: "Storage can fail, and the type says so",
      notes:
        "And every method can fail with a LinkStoreError, because databases fail. It's in the type.",
    },
  ]),

  // 4. The Worker
  ...chain(WORKER, [
    {
      title: "The agent writes a Worker that asks for Links",
      omit: ["handlers", "fetch"],
      error: { hide: true },
      notes:
        "Now the agent writes the Worker. It asks for Links, and for now provides it backed by D1.",
    },
    {
      title: "create calls Links",
      omit: ["get", "list", "fetch"],
      error: { hide: true },
      notes: "Implement create by calling links.create.",
    },
    {
      title: "get and list turn storage failures into a 500",
      omit: ["fetch"],
      error: { hide: true },
      notes:
        "get and list call Links too. A storage failure there is a defect, so it dies: the platform returns a 500.",
    },
    {
      title: "fetch serves the whole API",
      error: { hide: true },
      notes: "fetch serves ShortyApi with those handlers.",
    },
  ]),

  // 5. The loop: types, fix, tests
  term({
    title: "The agent checks its work with tsc first",
    notes: "Before anything runs, the agent type-checks. It's the fastest signal there is.",
    lines: TSC_ERROR,
  }),
  code({
    ...WORKER,
    title: "It forgot that create can fail with a LinkStoreError",
    error: {
      below: true,
      pick: (lines) =>
        lines.some((l) => l.includes("'LinkStoreError' is not assignable"))
          ? ["Type 'LinkStoreError' is not assignable to type 'never'."]
          : [],
    },
    notes:
      "And it caught something real. create can fail with a LinkStoreError, and the API contract doesn't have that error. Errors are in the type, so this is a compile error, not a surprise in production.",
  }),
  code({
    ...WORKER,
    snippet: "Api.ts",
    title: "So the agent decides what that failure means",
    notes: "Same decision as get: a storage failure is a defect.",
  }),
  term({ title: "tsc passes", notes: "Type-check again.", lines: TSC_OK, group: "tsc-ok" }),
  ...chain(TEST, [
    {
      title: "Now a test, which deploys the real Stack",
      omit: ["dev", "deploy", "test"],
      notes:
        "Types can't tell us the endpoints behave, so the agent writes a test. Test.make deploys the real Stack.",
    },
    {
      title: "dev: true runs it on your machine",
      omit: ["deploy", "test"],
      marks: [
        {
          kind: "circle",
          find: "dev: true",
          label: "local, in seconds",
          side: "right",
          tone: "good",
        },
      ],
      notes:
        "dev: true deploys to local simulators instead of the cloud: a local Worker, a local D1. No accounts, no waiting. That's what makes this fast enough for an agent's loop.",
    },
    {
      title: "Deploy it once, before the tests",
      omit: ["test"],
      notes: "Deploy the Stack once for the whole file.",
    },
    {
      title: "Each test gets a typed client to the deployed API",
      omit: ["create", "check"],
      notes:
        "The test calls the API through a client derived from ShortyApi, the same one the website will use.",
    },
    { title: "Create a link…", omit: ["check"], notes: "Create a link…" },
    { title: "…and read it back", notes: "…and read it back." },
  ]),
  term({
    title: "The agent runs the tests…",
    notes: "bun test deploys the Stack to a local stage.",
    tab: 2,
    lines: TEST_START,
  }),
  term({
    title: "…and they pass, in about a second",
    notes:
      "About a second and a half, including standing up the Worker and the database. That's the loop: types, then tests.",
    tab: 2,
    lines: [...TEST_START, ...TEST_OK],
    fresh: TEST_OK.length,
  }),

  // 6. A website
  code({
    ...STACK,
    snippet: "alchemy.run.ts",
    title: "So far the Stack is just the API",
    notes: "Here's the Stack so far: just the Worker.",
  }),
  ...chain(STACK, [
    {
      title: "Add a website to the Stack",
      omit: ["env", "returnWeb"],
      notes: "The website is one more resource: a Vite site on Cloudflare.",
    },
    {
      title: "…and give it the API's URL",
      omit: ["returnWeb"],
      notes: "It gets the Worker's URL as an environment variable.",
    },
    {
      title: "…and return its URL too",
      omit: ["returnApi"],
      notes: "And the Stack returns the website's URL.",
    },
  ]),
  code({
    title: "The website calls the API through the same typed client",
    notes:
      "The website calls the API with a client derived from ShortyApi. Rename an endpoint and the website stops compiling.",
    file: "web/src/client.ts",
    snippet: "client.ts",
  }),
  term({
    title: "alchemy dev runs it all locally",
    notes:
      "alchemy dev brings up the Worker, the database and the website locally, and reloads on every save.",
    tab: 1,
    lines: DEV_WEB,
  }),
  {
    kind: "browser",
    title: "Shorty, running locally",
    url: "http://localhost:5173",
    image: "01-api-browser-3.png",
    notes: "Here's the website, talking to the local API.",
  },
  {
    kind: "browser",
    title: "Shorten another link",
    url: "http://localhost:5173",
    image: "02-d1-browser-1.png",
    notes: "Shorten a link: the website calls the Worker, the Worker writes to the local database.",
  },

  // 7. Postgres, then production
  code({
    ...WORKER,
    snippet: "ApiNeon.ts",
    title: "For production, let's use Postgres on Neon",
    marks: [{ kind: "underline", find: "NeonStorage", tone: "construct" }],
    notes:
      "For production I want Postgres. Links is a service, so it's a one-word change: provide the Neon layer instead of D1.",
  }),
  ...chain(NEON, [
    {
      title: "NeonStorage starts with a Neon Postgres project",
      omit: ["pool", "connect", "sql", "bind"],
      notes:
        "So what is NeonStorage? It starts with a Neon Postgres project, running the same migrations as D1.",
    },
    {
      title: "Hyperdrive pools connections to it at the edge",
      omit: ["dev", "caching", "connect", "sql", "bind"],
      notes:
        "Workers are short-lived, so Hyperdrive keeps a pool of connections to Neon, close to the Worker.",
    },
    {
      title: "In dev, it connects straight to Neon's own pooler",
      omit: ["caching", "connect", "sql", "bind"],
      notes:
        "Under alchemy dev there's no Hyperdrive, so it goes straight to Neon's pooler instead.",
    },
    {
      title: "Caching off, so a new link is readable right away",
      omit: ["connect", "sql", "bind"],
      notes: "Hyperdrive can cache queries. Links need read-after-write, so caching is off.",
    },
    {
      title: "The Worker connects to the pool…",
      omit: ["sql"],
      notes:
        "Connect binds the Worker to the pool, and the binding layer wires it up at deploy time.",
    },
    {
      title: "…and hands LinksSql a Postgres client",
      notes:
        "And the result is a Postgres SQL client, which is all LinksSql needs. The Worker's code didn't change.",
    },
  ]),
  term({ title: "tsc passes", notes: "Types first, as always.", lines: TSC_OK, group: "tsc-2" }),
  term({
    title: "…and the same tests pass against Postgres",
    notes: "The same tests, unchanged, now against Postgres.",
    tab: 2,
    lines: [...TEST_START, ...TEST_OK],
    fresh: TEST_OK.length,
    group: "test-2",
  }),
  term({
    title: "Deploy to production, starting with a plan",
    notes:
      "alchemy deploy runs the Stack and shows the plan: Neon, Hyperdrive, the Worker with its binding, and the website.",
    lines: PLAN,
    group: "deploy",
  }),
  term({
    title: "Approve it, and it's live",
    notes: "Approve, and the providers create everything in order.",
    lines: APPLIED,
    group: "deploy-applied",
  }),
  {
    kind: "browser",
    title: "Shorty, in production",
    url: "https://shorty-web-prod.workers.dev",
    image: "09-deploy-browser-3.png",
    notes: "And there it is, in production, backed by Postgres. Same code, same tests.",
  },
];
