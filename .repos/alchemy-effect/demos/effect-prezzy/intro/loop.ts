/**
 * The second talk: the tightest feedback loop you can give an agent. A chat
 * app grows one piece at a time (Worker → Durable Object rooms over
 * WebSockets → R2 uploads → a queue into Postgres on Neon), and the same
 * end-to-end test follows it from the laptop, to a pull request's own copy,
 * to staging and prod. `intro/build.ts loop` resolves this into
 * `out/capture/loop/intro.json`; open it with `?deck=loop` in the presenter.
 *
 * Code comes from `snippets/chat/` and is type-checked; `*.error.ts` must fail.
 */
import type { LoopPart, MiniGraph, MiniNode, PyramidLayer } from "../shared/intro.ts";
import type {
  CodeSpec,
  CommentSpec,
  LoopSpec,
  PyramidSpec,
  RollSpec,
  StepSpec,
  TerminalSpec,
} from "./steps.ts";

// ── helpers ──────────────────────────────────────────────────────────────

const loop = (title: string, notes: string, lit?: LoopPart[], focus?: LoopPart[]): LoopSpec => ({
  kind: "loop",
  title,
  notes,
  lit,
  focus: focus ?? lit,
  frames: 20,
});

/** A code step from the chat app in `snippets/chat/`. */
const chat = (s: {
  title: string;
  notes: string;
  snippet: string;
  file: string;
  group: string;
  fontSize?: number;
  regions?: string[];
  omit?: string[];
  fold?: string[];
  marks?: CodeSpec["marks"];
  diagram?: MiniGraph;
  beside?: CodeSpec["beside"];
  links?: CodeSpec["links"];
  emphasize?: string[];
  error?: CodeSpec["error"];
  quiet?: boolean;
  tints?: CodeSpec["tints"];
  showRemoved?: boolean;
  reel?: CodeSpec["reel"];
  layer?: CodeSpec["layer"];
}): CodeSpec => ({
  kind: "code",
  group: s.group,
  file: s.file,
  title: s.title,
  src: { snippet: `chat/${s.snippet}`, regions: s.regions ?? ["show"], omit: s.omit, fold: s.fold },
  fontSize: s.fontSize,
  marks: s.marks,
  diagram: s.diagram,
  beside: s.beside,
  links: s.links,
  emphasize: s.emphasize,
  error: s.error,
  quiet: s.quiet,
  tints: s.tints,
  showRemoved: s.showRemoved,
  reel: s.reel,
  layer: s.layer,
  notes: s.notes,
  frames: s.diagram ? 45 : undefined,
});

/** Code written inline (config files, the AWS versions). */
const inline = (s: Omit<CodeSpec, "kind" | "src"> & { code: string }): CodeSpec => {
  const { code, ...rest } = s;
  return { kind: "code", src: { code }, ...rest };
};

// ── terminal output, in the CLI's own colors ─────────────────────────────
const T = {
  ok: "\x1b[38;5;113m",
  soft: "\x1b[38;5;150m",
  accent: "\x1b[38;5;173m",
  grey: "\x1b[38;5;102m",
  red: "\x1b[38;5;203m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};
const RULE = `${T.grey}${T.dim}${"─".repeat(52)}${T.reset}`;
const $ = (cmd: string) => `${T.dim}$${T.reset} ${cmd}`;
const res = (name: string, type: string) =>
  `${T.bold}${name}${T.reset} ${T.dim}(${type})${T.reset}`;
/** The test run's bracketing phases: what it stands up before the tests and tears down after. */
const DEPLOYED = [
  `${T.ok}${T.bold}▲ deploy${T.reset}   ${T.dim}Chat → stage${T.reset} ${T.bold}test_sam${T.reset}`,
  `  ${T.ok}+ Files  + Messages  + Db  + Pool  + Chat${T.reset}`,
];
const DESTROYED = [
  `${T.red}${T.bold}▼ destroy${T.reset}  ${T.dim}Chat ← stage${T.reset} ${T.bold}test_sam${T.reset}`,
  `  ${T.red}- Chat  - Pool  - Db  - Messages  - Files${T.reset}`,
];
const PASSED = `${T.ok}✓${T.reset} a message reaches everyone in the room`;
const term = (s: Omit<TerminalSpec, "kind" | "lines"> & { lines: string[] }): TerminalSpec => ({
  kind: "terminal",
  ...s,
  lines: s.lines.join("\n"),
});

// ── diagram helper (the shared-staging drawing) ─────────────────────────
const at = (
  node: { id: string; title: string; color: string },
  x: number,
  y: number,
  notes?: string[],
): MiniNode => ({
  ...node,
  x,
  y,
  ...(notes ? { notes } : {}),
});

// ── the stack: what "the code" actually is ─────────────────────────────
const LAYER = {
  infra: {
    id: "infra",
    title: "Infrastructure",
    detail: "compute · databases · buckets · queues · networks",
    color: "#8b9cf6",
  },
  config: {
    id: "config",
    title: "Configuration & policies",
    detail: "IAM · env vars · secrets · DNS",
    color: "#e0a86b",
  },
  api: {
    id: "api",
    title: "APIs & business logic",
    detail: "domain models · rules · workflows",
    color: "#a3c473",
  },
  web: { id: "web", title: "Frontend", detail: "websites · CDN · domains", color: "#e06c9f" },
} satisfies Record<string, PyramidLayer>;
const ALL_LAYERS = [LAYER.infra, LAYER.config, LAYER.api, LAYER.web];
const CHAT_LAYERS: PyramidLayer[] = [
  { ...LAYER.infra, detail: "R2 bucket · queue · Neon Postgres" },
  { ...LAYER.config, detail: "bindings · Hyperdrive · permissions" },
  { ...LAYER.api, detail: "rooms · messages · history · uploads" },
  { ...LAYER.web, detail: "the chat page, over WebSockets" },
];
/** Observability: beside the pyramid, spanning every layer. */
const OBSERVE = {
  title: "Observability",
  lines: ["traces", "logs", "metrics", "dashboards", "alarms"],
  color: "#56b6c2",
};
const pyramid = (
  s: Omit<PyramidSpec, "kind" | "layers"> & { layers?: PyramidLayer[] },
): PyramidSpec => ({
  kind: "pyramid",
  layers: ALL_LAYERS,
  frames: 24,
  ...s,
});

const opening: StepSpec[] = [
  {
    kind: "slide",
    layout: "title",
    title: "The tightest feedback loop from edit to production",
    eyebrow: "Alchemy",
    heading: "The tightest feedback loop\nfrom edit to production",
    subtitle:
      "Cloud programs composed from Layers:\ntype-checked, emulated locally, tested live, deployed per pull request",
    footer: "alchemy.run",
    notes:
      "I'm Sam, I work on Alchemy. This talk is about what an AI agent needs to go fast and still ship things that work.",
  },
];

const theStack: StepSpec[] = [
  pyramid({
    title: "The whole app starts with the infrastructure it runs on",
    layers: [LAYER.infra],
    notes:
      "Agents build, test and maintain whole apps, and a whole app is never just code. At the bottom is the infrastructure it runs on: compute, databases, buckets, queues, networks.",
  }),
  pyramid({
    title: "…wired together with configuration and policies",
    layers: [LAYER.infra, LAYER.config],
    notes:
      "On top of that is the glue: who can access what, environment variables, secrets, DNS records.",
  }),
  pyramid({
    title: "…running the APIs and business logic",
    layers: [LAYER.infra, LAYER.config, LAYER.api],
    notes:
      "Then the part we usually call the code: the APIs and business logic. The domain itself: its models, its rules, its workflows.",
  }),
  pyramid({
    title: "…behind a frontend served from a CDN",
    notes: "And at the top, the frontend people actually see, served from a CDN on a domain.",
  }),
  pyramid({
    title: "…and in production, you have to see every layer",
    pillar: OBSERVE,
    notes:
      "One more piece, and it isn't a layer. Production needs observability: traces, logs, metrics, and the dashboards and alarms that watch them. It's not on top or underneath. It runs beside the whole stack, because every layer feeds it. An agent has to get all of this right.",
  }),
  {
    kind: "arch",
    title: "We'll build a basic chat app on Cloudflare",
    lanes: [
      { label: "frontend", y: 250, color: "#e06c9f" },
      { label: "APIs & logic", y: 565, color: "#a3c473" },
      { label: "infrastructure", y: 890, color: "#8b9cf6" },
    ],
    nodes: [
      { id: "browser", title: "Website", sub: "Vite chat page", color: "#8b9cf6", x: 900, y: 250 },
      { id: "chat", title: "Chat", sub: "Cloudflare Worker", color: "#f38020", x: 900, y: 460 },
      { id: "rooms", title: "Rooms", sub: "Durable Objects", color: "#e06c9f", x: 900, y: 670 },
      { id: "files", title: "Files", sub: "R2 bucket", color: "#8b7cf6", x: 480, y: 890 },
      {
        id: "messages",
        title: "Messages",
        sub: "Cloudflare Queue",
        color: "#e0a86b",
        x: 900,
        y: 890,
      },
      { id: "history", title: "History", sub: "Neon Postgres", color: "#34d399", x: 1320, y: 890 },
    ],
    edges: [
      { from: "browser", to: "chat", label: "WebSocket" },
      { from: "chat", to: "rooms", label: "join" },
      { from: "chat", to: "files", label: "upload", elbow: true },
      { from: "rooms", to: "messages", label: "append" },
      { from: "messages", to: "history", label: "consume" },
    ],
    notes:
      "Here's what we'll build, top to bottom, the same way the pyramid reads. A Vite site is the chat page, and it connects to a Worker over a WebSocket. The Worker hands each room to its own Durable Object and stores uploads in an R2 bucket. Each room appends its messages to a queue, which fills a Postgres database on Neon with the history. And all of it will be traced, so we can see it in production.",
  },
];

// ── other IaC frameworks: two programs ─────────────────────────────────────────────────
const SST_CONFIG = `const bucket = new sst.aws.Bucket("Files");

new sst.aws.Function("Upload", {
  handler: "src/upload.handler",
  link: [bucket],
  url: true,
});`;
const SST_HANDLER = `import { Resource } from "sst";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

export const handler = async (event) => {
  await s3.send(new PutObjectCommand({
    Bucket: Resource.Files.name,
    Key: event.queryStringParameters.name,
    Body: event.body,
  }));
  return { statusCode: 201 };
};`;
const SST_BESIDE = { file: "src/upload.ts", src: { code: SST_HANDLER } };
/** What SST generates from the config, at the project root: one type for the whole app. */
const SST_ENV = `declare module "sst" {
  export interface Resource {
    "Files": { "name": string; "type": "sst.aws.Bucket" }
    "Upload": { "name": string; "type": "sst.aws.Function" }
  }
}`;
const sst = (s: Omit<CodeSpec, "kind" | "group" | "file" | "src" | "fontSize">): CodeSpec => ({
  kind: "code",
  group: "sst",
  file: "sst.config.ts",
  src: { code: SST_CONFIG },
  fontSize: 22,
  ...s,
});
const CUT = { under: "api", above: "runtime program", below: "infrastructure program" };
const UPLOAD = {
  label: "upload a file",
  items: {
    infra: "Files bucket",
    config: "s3:PutObject · $BUCKET",
    api: "upload handler",
    web: "upload button",
  },
};
const twoPrograms: StepSpec[] = [
  sst({
    title: "With other IaC frameworks like SST, you write two programs",
    beside: SST_BESIDE,
    notes:
      "So how would other infrastructure-as-code frameworks build this? Take one feature, uploading a file, with SST. sst.config.ts creates a bucket and a function and links them; it runs on your laptop at deploy time. The code that actually runs is a different file, bundled into Lambda. Two programs.",
  }),
  sst({
    title: "They're joined only by a file path and a generated name",
    beside: SST_BESIDE,
    links: [{ from: '"src/upload.handler"', to: "export const handler", tone: "bad" }],
    under: {
      file: "sst-env.d.ts",
      src: { code: SST_ENV },
      label: "code generation",
      links: [{ from: '"Files": {', to: "Resource.Files.name", tone: "bad" }],
    },
    notes:
      "The two programs meet at a string with a file path in it, and at a name. To make that name type-safe, SST runs code generation: it writes sst-env.d.ts from the config, with a type for every resource in the app, and the handler reads Resource.Files.name through it.",
  }),
  sst({
    title: "Code generation bridges the two, but it's an extra step to keep in sync",
    beside: {
      ...SST_BESIDE,
      marks: [
        {
          kind: "underline",
          find: "Resource.Files.name",
          label: "only as fresh as the last codegen",
          side: "right",
          tone: "bad",
        },
      ],
    },
    marks: [
      {
        kind: "circle",
        find: "link: [bucket]",
        label: "grants s3:* on the bucket",
        side: "right",
        tone: "bad",
      },
    ],
    under: {
      file: "sst-env.d.ts",
      src: { code: SST_ENV },
      label: "code generation",
      marks: [
        {
          kind: "underline",
          find: "export interface Resource",
          label: "one type for the whole app",
          side: "right",
          tone: "bad",
        },
      ],
    },
    notes:
      "So the two programs are connected, but only through code generation. That's friction: a generated file that has to be regenerated whenever the config changes, and until it is, the handler is typed against a stale picture. It describes the whole app, not what this function can use. And link can't know what the handler does, so it grants s3:* on the bucket and every object in it, even though the handler only calls PutObject. That's a lot of machinery for an agent to keep in its head.",
  }),
  pyramid({
    title: "SST, Pulumi, Terraform and the CDK all draw this line",
    layers: CHAT_LAYERS,
    cut: CUT,
    notes:
      "This isn't about SST. Pulumi, Terraform and the CDK all split an app the same way: a line through the middle of the stack. Infrastructure and policies below, in one program. The code that runs above, in another.",
  }),
  pyramid({
    title: "…but every feature crosses it",
    layers: CHAT_LAYERS,
    cut: CUT,
    slice: UPLOAD,
    notes:
      "But features don't live on one side of that line. Uploading a file needs a bucket, a permission and a variable, a handler, and a button. Every feature crosses the line, so every feature is split across two programs that have to agree.",
  }),
  pyramid({
    title: "An agent editing the handler can't see below the line",
    layers: CHAT_LAYERS,
    cut: CUT,
    slice: UPLOAD,
    lit: ["api", "web"],
    notes:
      "And that's exactly where an agent gets lost. It edits the handler. The bucket, the permission and the variable are in the other program. The type checker can't connect them, so the agent guesses, and finds out in production.",
  }),
  pyramid({
    title: "What if the feature owned both halves?",
    layers: CHAT_LAYERS,
    slice: { ...UPLOAD, label: "the Files module" },
    notes:
      "So erase the line. Instead of cutting the app horizontally into two programs, cut it vertically into modules. The Files module owns everything uploading needs: the bucket, the permission, and the code. And every module in the app will be a slice like that: a resource, a binding to it, and an API on top. We'll build each one exactly that way.",
  }),
];

const BRICKS = {
  files: {
    row: 0,
    col: 1,
    of: 2,
    title: "Files",
    detail: "R2 bucket · upload()",
    color: "#8b7cf6",
  },
  database: {
    row: 0,
    col: 0,
    of: 2,
    title: "Database",
    detail: "Neon · Hyperdrive",
    color: "#34d399",
  },
  history: { row: 1, title: "History", detail: "append() · list()", color: "#e0a86b" },
  rooms: { row: 2, title: "Rooms", detail: "Durable Objects · join()", color: "#e06c9f" },
  chat: { row: 3, title: "Chat", detail: "Worker · routes", color: "#f38020" },
};
const ALL_BRICKS = [BRICKS.database, BRICKS.files, BRICKS.history, BRICKS.rooms, BRICKS.chat];
/** Beside each row, the code that puts that block on the ones beneath it. */
const PROVIDES = {
  // Line one is Database's, line two is Files'; Files alone keeps its line.
  files: { layer: "infra", text: "\nconst FilesR2 = Layer.effect(Files, …)", code: true },
  bottom: {
    layer: "infra",
    text: "const DatabaseLive = Layer.unwrap(…)\nconst FilesR2 = Layer.effect(Files, …)",
    code: true,
  },
  history: { layer: "config", text: "const HistoryLive = Layer.effect(History, …)", code: true },
  rooms: { layer: "api", text: "const RoomsLive = Layer.effect(Rooms, …)", code: true },
  chat: { layer: "web", text: 'export default Cloudflare.Worker("Chat", …)', code: true },
};
/** Beside each row on the last slide: the Worker's wiring, which reads top to bottom as the pyramid. */
const WIRED = [
  { layer: "web", text: "Effect.provide(", code: true },
  { layer: "api", text: "  RoomsLive.pipe(", code: true },
  { layer: "config", text: "    Layer.provide(HistoryLive),", code: true },
  { layer: "infra", text: "    Layer.provide([DatabaseLive, FilesR2]),\n  ),\n)", code: true },
];
/** The chat app's pyramid, rebuilt from the modules implemented so far. */
const built = (
  title: string,
  bricks: typeof ALL_BRICKS,
  notes: string,
  side?: PyramidSpec["side"],
): PyramidSpec => pyramid({ title, layers: CHAT_LAYERS, bricks, notes, side });

// ── modules: effectful constructors ─────────────────────────────────────
const FILES = { snippet: "Files.ts", file: "src/Files.ts", group: "files", fontSize: 25 };
const MODULE_BESIDE_CLASS = {
  file: "the same shape, as a class",
  src: {
    code: `class FilesR2 {
  private bucket: Bucket;

  constructor() {
    this.bucket = new Bucket("Files");
  }

  upload(name: string, body: string) {
    return this.bucket.put(name, body);
  }
}`,
  },
};
/** History's dependencies, as a class receiving them. */
const HISTORY_BESIDE_CLASS = {
  file: "the same shape, as a class",
  src: {
    code: `class HistoryLive {
  constructor(private sql: Database) {}
}`,
  },
};
const modules: StepSpec[] = [
  chat({
    ...FILES,
    title: "In Alchemy, the Files module starts with the interface its callers use",
    regions: ["service"],
    notes:
      "Here's that module in Alchemy. It starts with an interface: Files can upload. That's a Context.Service, a plain Effect service. Callers only ever see this.",
  }),
  chat({
    ...FILES,
    title: "Its implementation starts with a resource: an R2 bucket",
    omit: ["service", "binding", "methods"],
    emphasize: ["R2.Bucket("],
    layer: "resource",
    notes:
      "The implementation is a Layer, and its constructor starts with what the module needs from the cloud: a resource, an R2 bucket. At deploy, this line creates it.",
  }),
  chat({
    ...FILES,
    title: "…adds a binding to it: read-write access…",
    omit: ["service", "methods"],
    layer: "binding",
    notes:
      "Then a binding: read-write access to that bucket. At deploy, it attaches the bucket to whatever Worker uses this module. At runtime, it hands back a client.",
  }),
  chat({
    ...FILES,
    title: "…and implements an API with it",
    omit: ["service"],
    layer: "api",
    notes:
      "Then the API: the methods the rest of the app calls, closing over that client. They're what run on each request. Resource, binding, API: one file holds the whole feature.",
  }),
  {
    ...chat({
      ...FILES,
      title: "It's an effectful constructor, like a class constructor",
      omit: ["service"],
      quiet: true,
      notes:
        "If that shape looks familiar, it's a class: a constructor that creates what the object needs, and methods that use it. Files has no dependencies; its constructor creates the bucket itself, like new Bucket(). The difference is that this constructor is an Effect, so creating the bucket means declaring a real cloud resource, and the type system tracks everything it needs.",
    }),
    beside: MODULE_BESIDE_CLASS,
    links: [
      { from: 'R2.Bucket("Files")', to: 'new Bucket("Files")', tone: "construct" },
      { from: "files.put(name, body)", to: "this.bucket.put(name, body)", tone: "runtime" },
    ],
  },
  chat({
    snippet: "FilesS3.ts",
    file: FILES.file,
    group: "files-s3",
    fontSize: 22,
    title: "On AWS, the constructor's binding becomes an IAM policy",
    beside: {
      file: "generated at deploy",
      lang: "yaml",
      src: {
        code: `# IAM policy on the Worker's role
Effect: Allow
Action: s3:PutObject
Resource: arn:aws:s3:::chat-dev-sam-files/*`,
      },
    },
    links: [{ from: "AWS.S3.PutObject(bucket)", to: "s3:PutObject", tone: "good" }],
    notes:
      "A quick detour to AWS, where this is easiest to see. Same module, backed by S3. The constructor asks for PutObject on this bucket, and at deploy that line becomes an IAM policy: exactly s3:PutObject, on exactly this bucket. Compare that with s3:* from link.",
  }),
  chat({
    snippet: "FilesS3.ts",
    file: FILES.file,
    group: "files-s3",
    fontSize: 22,
    title: "…plus an environment variable with the bucket's name",
    beside: {
      file: "generated at deploy",
      lang: "yaml",
      src: {
        code: `# IAM policy on the Worker's role
Effect: Allow
Action: s3:PutObject
Resource: arn:aws:s3:::chat-dev-sam-files/*

# Worker environment
$BUCKET_NAME: chat-dev-sam-files`,
      },
    },
    links: [
      { from: "AWS.S3.PutObject(bucket)", to: "s3:PutObject", tone: "good" },
      { from: "putObject({", to: "$BUCKET_NAME", tone: "good" },
    ],
    notes:
      "It also sets $BUCKET_NAME, so putObject knows where to write. Nobody writes the policy or the variable by hand. Delete the line and the permission goes with it, and anything that used it stops compiling. And callers don't change at all: it's still Files.",
  }),
  chat({
    snippet: "FilesRead.error.ts",
    file: FILES.file,
    group: "files-read",
    fontSize: FILES.fontSize,
    title: "The types match the policy: ask for read-only and upload won't compile",
    error: { pick: (lines) => lines.filter((line) => line.includes("'put'")).slice(0, 1) },
    emphasize: ["R2.ReadBucket(bucket)"],
    notes:
      "Back on R2. Because every binding is a policy, the types the binding hands back are exactly what that policy allows. Ask for read-only access and you get a read-only client, with no put, so upload stops compiling. Least privilege isn't something to review after the fact. The type checker guarantees the policy and the code agree, and the agent finds out in milliseconds, in the editor.",
  }),
];

// ── composing modules as Layers ──────────────────────────────────────────
const HISTORY = { snippet: "History.ts", file: "src/History.ts", group: "history", fontSize: 19 };
const ROOM_FILE = { snippet: "Room.ts", file: "src/Room.ts", group: "room", fontSize: 22 };
const WORKER = { snippet: "ChatModules.ts", file: "src/Chat.ts", group: "chat", fontSize: 17 };
const compose: StepSpec[] = [
  chat({
    snippet: "DbSteps.ts",
    file: "src/Db.ts",
    group: "db",
    fontSize: 25,
    omit: ["pool", "connect", "ret"],
    title: "The Database module starts with a Neon Postgres project",
    layer: "resource",
    notes:
      "Same shape as Files: an interface, then a Layer. The interface is just a SQL client, called Database. The Layer's constructor declares what it needs, starting with a Neon Postgres project. Alchemy creates it at deploy and applies the migrations in ./migrations.",
  }),
  chat({
    snippet: "DbSteps.ts",
    file: "src/Db.ts",
    group: "db",
    fontSize: 25,
    omit: ["connect", "ret"],
    title: "Hyperdrive puts a connection pool in front of it",
    layer: "resource",
    notes:
      "Workers are short-lived, so opening a Postgres connection on every request is slow. Hyperdrive keeps a pool of connections near the database. Its origin is the project's origin: one resource's output is the next one's input.",
  }),
  chat({
    snippet: "DbSteps.ts",
    file: "src/Db.ts",
    group: "db",
    fontSize: 25,
    omit: ["ret"],
    title: "Connect binds that pool to whichever Worker uses this module",
    layer: "binding",
    notes:
      "Connect is a binding, like ReadWriteBucket was for Files. At deploy it adds the Hyperdrive pool to the Worker that ends up using this module. At runtime it hands back the pool's connection string.",
  }),
  chat({
    snippet: "DbSteps.ts",
    file: "src/Db.ts",
    group: "db",
    fontSize: 25,
    title: "The constructor returns a SQL client for the rest of the app",
    layer: "api",
    notes:
      "Then the constructor returns a Postgres Layer built from that connection string. That's why this is Layer.unwrap: the constructor's result is itself a Layer, and anything above it just asks for a SQL client. That's the whole Database module: a project, a pool, a binding, and a SQL client, in one file.",
  }),
  chat({
    ...HISTORY,
    title: "History starts as an empty Layer",
    omit: ["service", "deps", "queue", "consume", "append", "list"],
    notes:
      "Chat history is the next module. Like the others, it's a Layer: a constructor that returns the methods the rest of the app calls. It starts empty.",
  }),
  chat({
    ...HISTORY,
    title: "It asks for the Database",
    omit: ["service", "queue", "consume", "append", "list"],
    beside: HISTORY_BESIDE_CLASS,
    links: [{ from: "yield* Database", to: "private sql: Database", tone: "construct" }],
    notes:
      "Unlike Files, History doesn't create anything yet: its constructor asks for the Database module we just built. As a class, that would be a constructor parameter. It only names what it needs. It doesn't say which implementation, or where the database lives. That gets decided once, at the top.",
  }),
  chat({
    ...HISTORY,
    title: "list reads a room's messages from Postgres",
    omit: ["service", "queue", "consume", "append"],
    layer: "api",
    notes: "The first method: list. One query against the database for a room's messages.",
  }),
  chat({
    ...HISTORY,
    title: "New messages go on a queue that History declares itself",
    omit: ["service", "queueBinding", "consume", "append"],
    layer: "resource",
    notes:
      "Messages arrive faster than we want to write them one at a time, so they go through a queue. History declares the queue right in its constructor: a resource, a Cloudflare Queue called Messages. Nothing else in the app knows it exists.",
  }),
  chat({
    ...HISTORY,
    title: "…with a binding that can send to it",
    omit: ["service", "consume", "append"],
    layer: "binding",
    notes: "Then a binding: send access to that queue, and a client for it.",
  }),
  chat({
    ...HISTORY,
    title: "append puts a message on that queue",
    omit: ["service", "consume"],
    layer: "api",
    notes:
      "append sends a room name and the text onto the queue. That's what every chat room will call.",
  }),
  chat({
    ...HISTORY,
    title: "…and History consumes the queue into Postgres",
    omit: ["service"],
    layer: "binding",
    notes:
      "And History consumes its own queue, inserting each message into Postgres. Subscribing to a queue is an event source, and it's declared in the constructor like any binding: at deploy, it registers this Worker as the queue's consumer.",
  }),
  chat({
    ...HISTORY,
    title: "On Cloudflare, that line registers the Worker as the queue's consumer",
    omit: ["service"],
    emphasize: ["Queues.consumeQueueMessages", "Queues.WriteQueue(messages)"],
    beside: {
      file: "on Cloudflare, generated at deploy",
      lang: "yaml",
      src: {
        code: `# Worker binding (send access)
- type: queue
  name: Messages
  queue_name: chat-dev-sam-messages

# Queue consumer
queue: chat-dev-sam-messages
script: chat-dev-sam-chat
settings:
  batch_size: 10
  max_retries: 3`,
      },
    },
    links: [
      { from: "consumeQueueMessages", to: "# Queue consumer", tone: "good" },
      { from: "Queues.WriteQueue(messages)", to: "type: queue", tone: "good" },
    ],
    notes:
      "Here's what those lines do on Cloudflare. consumeQueueMessages registers this Worker as the Messages queue's consumer, with its batch settings. WriteQueue adds a queue binding to the Worker, so it can send. No policies: on Cloudflare, access is the binding itself.",
  }),
  chat({
    ...HISTORY,
    title: "On AWS, the same line would grant three permissions and wire the trigger",
    omit: ["service"],
    emphasize: ["consumeQueueMessages"],
    beside: {
      file: "on AWS, generated at deploy",
      lang: "yaml",
      src: {
        code: `# IAM policy on the Lambda's role
Effect: Allow
Action:
  - sqs:ReceiveMessage
  - sqs:DeleteMessage
  - sqs:GetQueueAttributes
Resource: arn:aws:sqs:…:chat-dev-sam-messages

# Event source mapping
EventSourceArn: arn:aws:sqs:…:chat-dev-sam-messages
FunctionName: chat-dev-sam-history`,
      },
    },
    links: [
      { from: "consumeQueueMessages", to: "sqs:ReceiveMessage", tone: "good" },
      { from: "consumeQueueMessages", to: "EventSourceArn", tone: "good" },
    ],
    notes:
      "Now the same code on AWS, where the queue would be SQS and History would run in a Lambda. The same call does more: it grants exactly the three actions a consumer needs, on exactly this queue, and creates the event source mapping that invokes the Lambda with each batch. The trigger and its permissions exist exactly as long as that line does.",
  }),
  chat({
    ...ROOM_FILE,
    title: "Each room is a Durable Object that holds its sockets",
    omit: ["history", "send"],
    notes:
      "Next, the chat rooms. Each room is its own Durable Object: one small stateful server per room name. It has the same shape as everything else, a constructor, then methods. Its fetch accepts a WebSocket, and each message goes to every socket in the room.",
  }),
  chat({
    ...ROOM_FILE,
    title: "…and each room appends its messages to History",
    emphasize: ["yield* History", "history.append"],
    notes:
      "Each room asks for History and appends every message to it. The room doesn't know there's a queue or a database behind History. That's History's business. And like every other module, it doesn't say where History comes from; the Worker decides that.",
  }),
  chat({
    ...WORKER,
    title: "The Chat Worker wires up the whole stack of Layers",
    emphasize: [
      "yield* Room;",
      "yield* History;",
      "yield* Files;",
      "Effect.provide(",
      "HistoryLive.pipe(Layer.provide(DatabaseLive))",
      "      FilesR2,",
    ],
    notes:
      "The Worker asks for the rooms, History and Files. join hands the WebSocket to that room's Durable Object, uploads go to Files, and history comes from History. At the bottom it wires the Layers: HistoryLive on DatabaseLive, and FilesR2. That one expression is the whole app's wiring, and it's the only place that decides which implementation each module gets. The rooms get History from here too.",
  }),
  chat({
    snippet: "ChatMissing.error.ts",
    file: WORKER.file,
    group: WORKER.group,
    fontSize: WORKER.fontSize,
    title: "Forget a Layer and the Worker doesn't compile",
    error: {
      pick: (lines) =>
        lines.filter((line) => line.startsWith("Type 'Files' is not assignable")).slice(0, 1),
      below: true,
    },
    showRemoved: true,
    notes:
      "Leave FilesR2 out of the stack, and the Worker doesn't compile. The type says exactly which module is missing. That's the agent's fastest feedback: it can't deploy an app with a hole in it.",
  }),
  chat({
    snippet: "ChatTraced.ts",
    file: WORKER.file,
    group: WORKER.group,
    fontSize: WORKER.fontSize,
    title: "Collecting every trace and log is one line in the Worker",
    emphasize: ["Axiom.Telemetry("],
    notes:
      "One thing is missing for production: observability, the column beside the pyramid. Start with the simplest version. One line in the Worker: Axiom.Telemetry, pointed at an Axiom token and two datasets. It's an OpenTelemetry exporter, and every module is already written in Effect, so every step in the rooms, History, Files and Database becomes a span and every log line is shipped, with no changes to any of them.",
  }),
  ...[
    {
      omit: ["dashboard", "monitor"],
      title: "Production also needs dashboards and alarms, so move it into a Layer",
      notes:
        "Collecting is only half of it. Production also needs something that plots the data and something that wakes you up. So move it into its own module: an Observability Layer. Its constructor declares where telemetry goes, two Axiom datasets and an ingest token that can only write to them, and returns the same Axiom.Telemetry.",
    },
    {
      omit: ["monitor"],
      title: "…with a dashboard that plots the errors…",
      notes:
        "Its constructor declares a dashboard, with a chart of errors over time. It's a resource like any other, so it's deployed and versioned with the app.",
    },
    {
      omit: [],
      title: "…and a monitor that alerts on them",
      notes:
        "And a monitor that fires when errors pass a threshold. In production, that alert is one more failure that goes back to the agent.",
    },
  ].map((step) =>
    chat({
      snippet: "Observability.ts",
      file: "src/Observability.ts",
      group: "observability",
      fontSize: 22,
      omit: step.omit,
      title: step.title,
      notes: step.notes,
    }),
  ),
  chat({
    snippet: "ChatObserved.ts",
    file: WORKER.file,
    group: WORKER.group,
    fontSize: WORKER.fontSize,
    title: "The Worker provides the Layer instead, beside the stack",
    showRemoved: true,
    notes:
      "Back in the Worker, the Telemetry line becomes ObservabilityLive. Same traces and logs, and now the dashboard and the monitor deploy with the app.",
  }),
  {
    kind: "dash",
    title: "Deploy, and the dashboard is already there",
    notes:
      "Here's roughly what that gets you, mocked up. Deploy, and the dashboard exists: requests and errors over time, and every trace, broken down by module, because every module is already traced. Nobody clicked anything in a console.",
  },
  {
    kind: "dash",
    title: "When errors spike, the monitor fires, and the agent hears about it",
    alert: true,
    notes:
      "And when something breaks in production, say uploads start timing out, the errors cross the threshold and the monitor fires. The trace points straight at Files.upload. That alert is one more failure that goes back to the agent, from production this time.",
  },
];

// ── the Stack: deploy, destroy, dev ──────────────────────────────────────
const program: StepSpec[] = [
  chat({
    snippet: "alchemy.run.ts",
    file: "alchemy.run.ts",
    group: "stack",
    fontSize: 30,
    omit: ["providers", "state", "chat", "ret"],
    title: "That one program is deployed as a Stack",
    notes:
      "That one program needs an entry point: the Stack. It's an Effect program too: a name, some configuration, and a body.",
  }),
  chat({
    snippet: "alchemy.run.ts",
    file: "alchemy.run.ts",
    group: "stack",
    fontSize: 30,
    omit: ["state", "chat", "ret"],
    title: "providers says which clouds it can create things in",
    notes:
      "providers says which clouds this Stack can create resources in: Cloudflare and Neon. They're Layers too.",
  }),
  chat({
    snippet: "alchemy.run.ts",
    file: "alchemy.run.ts",
    group: "stack",
    fontSize: 30,
    omit: ["chat", "ret"],
    title: "state says where it records what it created",
    notes:
      "state says where the Stack records what it created, so the next deploy knows what already exists. Here, in Cloudflare.",
  }),
  chat({
    snippet: "alchemy.run.ts",
    file: "alchemy.run.ts",
    group: "stack",
    fontSize: 30,
    omit: ["ret"],
    title: "Its body yields the Chat Worker, and every Layer beneath it",
    notes:
      "The body yields the Chat Worker. That one line pulls in everything: the rooms, History, Files, Database, and all their resources and bindings.",
  }),
  chat({
    snippet: "StackNoProviders.error.ts",
    file: "alchemy.run.ts",
    group: "stack",
    fontSize: 30,
    omit: ["ret"],
    title: "Leave out the providers and the Stack doesn't compile",
    error: {
      pick: (lines) =>
        lines.filter((line) => line.startsWith("Type 'Layer<never, never, never>'")).slice(0, 1),
      below: true,
    },
    showRemoved: true,
    notes:
      "Take the providers away and it's a type error. Because the body yields the Chat Worker, the Stack's type knows every kind of resource underneath it: a Cloudflare Worker, an R2 bucket, a queue, a Neon project. So it knows exactly which providers it needs, and it won't compile until you configure all of them.",
  }),
  chat({
    snippet: "alchemy.run.ts",
    file: "alchemy.run.ts",
    group: "stack",
    fontSize: 30,
    emphasize: ["return { url"],
    title: "…and returns what the app exposes: its URL",
    notes:
      "And it returns the Stack's outputs, here the Worker's URL, so deploys and tests can find the app.",
  }),
  term({
    group: "cli",
    title: "alchemy deploy plans what has to change",
    lines: [
      $("alchemy deploy"),
      `${T.ok}✓${T.reset} Plan ready`,
      RULE,
      `${T.accent}${T.bold}Deploy${T.reset}${T.dim} · ${T.reset}${T.ok}10 to create${T.reset}${T.dim} · ${T.reset}${T.soft}6 bindings${T.reset}`,
      ``,
      `${T.ok}+${T.reset} ${res("Files", "Cloudflare.R2.Bucket")}`,
      `${T.ok}+${T.reset} ${res("Messages", "Cloudflare.Queues.Queue")}`,
      `${T.ok}+${T.reset} ${res("Db", "Neon.Project")}`,
      `${T.ok}+${T.reset} ${res("Pool", "Cloudflare.Hyperdrive")}`,
      `${T.ok}+${T.reset} ${res("Traces", "Axiom.Dataset")}`,
      `${T.ok}+${T.reset} ${res("Logs", "Axiom.Dataset")}`,
      `${T.ok}+${T.reset} ${res("Ingest", "Axiom.ApiToken")}`,
      `${T.ok}+${T.reset} ${res("Dashboard", "Axiom.Dashboard")}`,
      `${T.ok}+${T.reset} ${res("Errors", "Axiom.Monitor")}`,
      `${T.ok}+${T.reset} ${res("Chat", "Cloudflare.Worker")}`,
      `  ${T.ok}+${T.reset} ${T.soft}Cloudflare.R2.ReadWrite(Files)${T.reset}`,
      `  ${T.ok}+${T.reset} ${T.soft}Cloudflare.Queues.Write(Messages)${T.reset}`,
      `  ${T.ok}+${T.reset} ${T.soft}Cloudflare.Queues.Consume(Messages)${T.reset}`,
      `  ${T.ok}+${T.reset} ${T.soft}Cloudflare.Hyperdrive.Connect(Pool)${T.reset}`,
      `  ${T.ok}+${T.reset} ${T.soft}Cloudflare.DurableObject(Room)${T.reset}`,
      `  ${T.ok}+${T.reset} ${T.soft}Axiom.Telemetry(Ingest)${T.reset}`,
    ],
    notes:
      "alchemy deploy first compares that program with what's in the cloud and plans what has to change. Nothing exists yet, so everything is a create: every resource, every binding between them, and the dashboard and monitor that watch them.",
  }),
  term({
    group: "cli-apply",
    title: "…then makes the cloud match, in dependency order",
    lines: [$("alchemy deploy"), `${T.ok}✓${T.reset} Plan ready`, RULE],
    fresh: 0,
    progress: {
      rows: [
        { name: "Files", type: "Cloudflare.R2.Bucket", from: 4, to: 26 },
        { name: "Messages", type: "Cloudflare.Queues.Queue", from: 6, to: 24 },
        { name: "Db", type: "Neon.Project", from: 4, to: 50 },
        { name: "Traces", type: "Axiom.Dataset", from: 5, to: 18 },
        { name: "Logs", type: "Axiom.Dataset", from: 5, to: 20 },
        { name: "Ingest", type: "Axiom.ApiToken", from: 21, to: 32 },
        { name: "Dashboard", type: "Axiom.Dashboard", from: 21, to: 36 },
        { name: "Errors", type: "Axiom.Monitor", from: 22, to: 38 },
        { name: "Pool", type: "Cloudflare.Hyperdrive", from: 51, to: 68 },
        { name: "Chat", type: "Cloudflare.Worker", from: 69, to: 96 },
        { name: "Cloudflare.R2.ReadWrite(Files)", binding: true, from: 97, to: 104 },
        { name: "Cloudflare.Queues.Write(Messages)", binding: true, from: 97, to: 105 },
        { name: "Cloudflare.Queues.Consume(Messages)", binding: true, from: 98, to: 108 },
        { name: "Cloudflare.Hyperdrive.Connect(Pool)", binding: true, from: 98, to: 106 },
        { name: "Cloudflare.DurableObject(Room)", binding: true, from: 99, to: 107 },
        { name: "Axiom.Telemetry(Ingest)", binding: true, from: 99, to: 109 },
      ],
      done: [
        RULE,
        `${T.ok}Stack deployed (10/10)${T.reset} ${T.dim}{ url: "https://chat-dev-sam.workers.dev" }${T.reset}`,
      ].join("\n"),
      at: 112,
    },
    notes:
      "Then it does it. Everything that doesn't depend on anything starts at once: the bucket, the queue, the Neon project, the Axiom datasets. The token, dashboard and monitor wait for the datasets. Hyperdrive waits for the database. The Worker waits for all of it, and then its bindings attach. At the end, the Stack's outputs: the app's URL.",
  }),
  term({
    group: "cli",
    title: "Running it again changes nothing",
    lines: [
      $("alchemy deploy"),
      `${T.ok}✓${T.reset} Plan ready`,
      RULE,
      `${T.dim}No changes${T.reset}`,
    ],
    notes:
      "Run it again and nothing happens. The program describes the end state, not the steps to get there, so it's always safe to run. An agent can't break anything by deploying twice.",
  }),
  term({
    group: "cli",
    title: "alchemy destroy removes every piece of it",
    lines: [
      $("alchemy destroy"),
      `${T.red}-${T.reset} ${res("Chat", "Cloudflare.Worker")} deleted`,
      `${T.red}-${T.reset} ${res("Pool", "Cloudflare.Hyperdrive")} deleted`,
      `${T.red}-${T.reset} ${res("Errors", "Axiom.Monitor")} deleted`,
      `${T.red}-${T.reset} ${res("Dashboard", "Axiom.Dashboard")} deleted`,
      `${T.red}-${T.reset} ${res("Ingest", "Axiom.ApiToken")} deleted`,
      `${T.red}-${T.reset} ${res("Logs", "Axiom.Dataset")} deleted`,
      `${T.red}-${T.reset} ${res("Traces", "Axiom.Dataset")} deleted`,
      `${T.red}-${T.reset} ${res("Db", "Neon.Project")} deleted`,
      `${T.red}-${T.reset} ${res("Messages", "Cloudflare.Queues.Queue")} deleted`,
      `${T.red}-${T.reset} ${res("Files", "Cloudflare.R2.Bucket")} deleted`,
      RULE,
      `${T.ok}Stack destroyed (10/10)${T.reset}`,
    ],
    notes:
      "And destroy removes everything the Stack created, in reverse dependency order: the Worker first, then what it used, down to the bucket, the queue and the database. Nothing left behind to clean up by hand.",
  }),
  term({
    group: "cli",
    title: "alchemy dev runs the same program on your machine",
    lines: [
      $("alchemy dev"),
      `${T.ok}✓${T.reset} ${res("Chat", "Cloudflare.Worker")} ${T.dim}→${T.reset} http://localhost:1337`,
      `${T.dim}watching for changes…${T.reset}`,
    ],
    notes:
      "And alchemy dev runs the same program locally, with emulated Cloudflare services. Because the whole app is one declarative program, an agent can stand it up, tear it down, and run it locally, all by itself. Which brings us back to the question we started with: how does it know the app works?",
  }),
];

// ── act 0: the loop, introduced one piece at a time ─────────────────────
/** A map step that draws only `show`, everything lit. */
const reveal = (title: string, notes: string, show: LoopPart[], focus?: LoopPart[]): LoopSpec => ({
  kind: "loop",
  title,
  notes,
  show,
  focus,
  frames: 30,
});
const MACHINE: LoopPart[] = ["edit", "types", "local", "live", "feedback"];
const PULL: LoopPart[] = ["push", "pr", "prTest", "comment"];
const MAIN: LoopPart[] = ["merge", "staging", "stagingTest", "prod"];
const theLoop: StepSpec[] = [
  reveal(
    "So an agent can change any part of this app in seconds",
    "Here's the agent. It can change any layer of this app in seconds, and it'll happily tell you it's done. How does it actually find out?",
    ["edit"],
  ),
  reveal(
    "Getting that change safely into production takes much longer",
    "Over here is production. Between the two is everything that decides whether that edit was right. Each of those steps is feedback, and the agent can only move as fast as the slowest one it has to wait for.",
    ["edit", "prod"],
  ),
  reveal(
    "The type checker answers first, and now it sees every layer",
    "The first check is the one we just built: the type checker. Because the whole app is one program, it covers the bucket, the permission and the code, in milliseconds, pointing at the exact line. Every failure goes back to the agent, which fixes it and tries again.",
    ["edit", "types", "feedback", "prod"],
    ["types"],
  ),
  reveal(
    "Tests on emulated services answer in seconds",
    "Next, tests that run the whole app on your machine, against emulated cloud services. Seconds, free, and the agent can run them after every change.",
    ["edit", "types", "local", "feedback", "prod"],
    ["local"],
  ),
  reveal(
    "Tests against the real cloud catch what emulators miss",
    "Then the same tests against the real cloud, in a stage of their own. Slower, but that's where permissions, networking and real service behavior show up.",
    [...MACHINE, "prod"],
    ["live"],
  ),
  reveal(
    "A pull request gets its own copy of the app to test",
    "When it's green locally, the agent opens a pull request. CI deploys a copy of the app just for that PR, runs the same tests, and comments with a link to try it.",
    [...MACHINE, ...PULL, "prod"],
    PULL,
  ),
  reveal(
    "Merging runs the same tests again on staging",
    "Merging deploys staging and runs the same tests one more time. Only a green staging goes to prod. That's every step between an edit and production: your machine, the pull request, and main. We have the first box. The rest of this talk builds the others.",
    [...MACHINE, ...PULL, ...MAIN],
    ["merge", "staging", "stagingTest"],
  ),
];

// ── act 3: one test for the whole app, local or live ─────────────────────
const TEST = { snippet: "chat.test.ts", file: "test/chat.test.ts", group: "test", fontSize: 27 };
const LOCAL_RUN = [
  $("LOCAL=1 pnpm test"),
  `${T.ok}${T.bold}▲ start${T.reset}    ${T.dim}Chat →${T.reset} ${T.bold}http://localhost:1337${T.reset}`,
  PASSED,
  `${T.red}${T.bold}▼ stop${T.reset}     ${T.dim}Chat${T.reset}`,
];
const tests: StepSpec[] = [
  loop(
    "Next, tests that prove the whole app works",
    "Types say the pieces fit together. They can't say that a message Alice sends actually reaches Bob. For that the agent needs tests that run the whole app, on its machine and in the real cloud.",
    ["local", "live"],
  ),
  chat({
    ...TEST,
    title: "A test deploys the whole Stack first, and destroys it after",
    omit: ["dev", "test", "stage"],
    notes:
      "An end-to-end test starts by deploying the same Stack. deploy(Stack) runs once for the file, so every test shares one deployment, and destroy(Stack) tears it all down when the file is done.",
  }),
  chat({
    ...TEST,
    title: "Then it talks to the app the way a user would",
    omit: ["dev", "history", "stage"],
    notes:
      "Then it uses the app like a person would. Alice and Bob join the lobby over WebSockets, Alice says hi, Bob hears it. That goes through the Worker and the Durable Object.",
  }),
  chat({
    ...TEST,
    title: "It checks the queue and the database too",
    omit: ["dev", "stage"],
    notes:
      "And the message should land in history, which means it went through the queue, the consumer and Postgres. One test covers every piece of the app.",
  }),
  term({
    group: "test-run",
    title: "pnpm test runs it against the real cloud",
    lines: [
      $("pnpm test"),
      ...DEPLOYED,
      ``,
      PASSED,
      ``,
      ...DESTROYED,
      ``,
      `${T.ok}1 passed${T.reset}`,
    ],
    notes:
      "Run it, and the test deploys the whole app to a stage of its own, test_sam, in the real cloud: real Workers, real queues, a real Neon database. The test runs against it, and afterwards every resource is destroyed. Nothing shared with your dev stage or anyone else's, and nothing left behind.",
  }),
  chat({
    snippet: "chat-dev.test.ts",
    file: TEST.file,
    group: "test-dev",
    fontSize: 30,
    title: "dev: true runs the same Stack on emulated services",
    emphasize: ["dev: true"],
    notes:
      "First box: emulated. Set dev to true and the test runs the whole Stack on emulated services: workerd for the Worker, Durable Objects, R2 and queues, locally. Same Stack, same test.",
  }),
  chat({
    snippet: "chat.test.ts",
    file: TEST.file,
    group: "test-dev",
    fontSize: 30,
    regions: ["make"],
    omit: ["stage"],
    title: "An environment variable decides where it runs",
    emphasize: ["dev: !!process.env.LOCAL"],
    notes:
      "Make it an environment variable, and the agent picks: LOCAL=1 while it iterates, and without it, the real cloud.",
  }),
  term({
    group: "test-run",
    title: "LOCAL=1 runs it on emulated services",
    lines: [...LOCAL_RUN],
    notes:
      "With LOCAL=1, the same test starts the whole app on emulated services on your machine, runs, and stops it. It's fast and free, so the agent can run it after every change.",
  }),
  term({
    group: "test-run",
    title: "Emulated for speed, live for the real thing",
    lines: [...LOCAL_RUN, ``, $("pnpm test"), ...DEPLOYED, PASSED, ...DESTROYED],
    fresh: 7,
    notes:
      "Without it, the same command runs live. Both are one command away: emulated after every change, live to catch what emulation can't, like permissions and real network behavior.",
  }),
];

// ── act 4: every pull request gets its own copy ──────────────────────────
const PR_YAML = `on: pull_request

jobs:
  test:
    runs-on: ubuntu-latest
    env:
      STAGE: pr-\${{ github.event.number }}
    steps:
      - uses: actions/checkout@v5
      - run: pnpm install
      - run: pnpm test`;
const PR_YAML_CLOSE = `on:
  pull_request:
    types: [opened, synchronize, closed]

jobs:
  test:
    if: github.event.action != 'closed'
    runs-on: ubuntu-latest
    env:
      STAGE: pr-\${{ github.event.number }}
    steps:
      - uses: actions/checkout@v5
      - run: pnpm install
      - run: pnpm test

  cleanup:
    if: github.event.action == 'closed'
    runs-on: ubuntu-latest
    steps:
      - run: pnpm alchemy destroy --stage pr-\${{ github.event.number }}`;
const ci: StepSpec[] = [
  loop(
    "Green on your machine, the agent opens a pull request",
    "Once the tests pass locally, the agent pushes and opens a pull request. Now we walk the pull request lane, left to right.",
    ["push"],
  ),
  loop(
    "CI deploys a copy of the app just for that pull request",
    "First box: deploy. CI can't use the agent's copy of the app, so it deploys one of its own, just for pull request 42.",
    ["pr"],
  ),
  term({
    group: "stages",
    title: "A stage gives it a complete, isolated copy of the app",
    lines: [
      $("alchemy deploy --stage pr-42"),
      `${T.accent}${T.bold}Deploy${T.reset}${T.dim} · ${T.reset}${T.ok}6 to create${T.reset}`,
      ``,
      `${T.ok}+${T.reset} ${res("Room", "Cloudflare.DurableObject")}`,
      `${T.ok}+${T.reset} ${res("Files", "Cloudflare.R2.Bucket")}     ${T.soft}chat-pr-42-files${T.reset}`,
      `${T.ok}+${T.reset} ${res("Messages", "Cloudflare.Queues.Queue")} ${T.soft}chat-pr-42-messages${T.reset}`,
      `${T.ok}+${T.reset} ${res("Db", "Neon.Project")}             ${T.soft}chat-pr-42-db${T.reset}`,
      `${T.ok}+${T.reset} ${res("Pool", "Cloudflare.Hyperdrive")}    ${T.soft}chat-pr-42-pool${T.reset}`,
      `${T.ok}+${T.reset} ${res("Chat", "Cloudflare.Worker")}        ${T.soft}chat-pr-42-chat${T.reset}`,
    ],
    notes:
      "A stage is a name, like dev_sam, test_sam or pr-42. Every resource's physical name includes it, and every stage keeps its own state. Deploy a new stage and you get a whole new copy of the app.",
  }),
];

// ── act 5: shared infrastructure, by reference ───────────────────────────
const DB_FILE = { snippet: "DbBranch.ts", file: "src/Db.ts", group: "db", fontSize: 25 };
const staging = (id: string, title: string, color: string, x: number) =>
  at({ id, title, color }, x, 110);
const pr = (id: string, title: string, color: string, x: number, y: number) =>
  at({ id, title, color }, x, y);
const SHARED: MiniGraph = {
  nodes: [
    staging("sChat", "Chat", "#f38020", 360),
    pr("w41", "pr-41", "#f38020", 120, 330),
    pr("w42", "pr-42", "#f38020", 360, 330),
    pr("w43", "pr-43", "#f38020", 600, 330),
    at({ id: "sDb", title: "Db", color: "#34d399" }, 360, 500),
    pr("d41", "pr-41", "#34d399", 120, 710),
    pr("d42", "pr-42", "#34d399", 360, 710),
    pr("d43", "pr-43", "#34d399", 600, 710),
  ],
  edges: [
    { from: "sChat", to: "w41" },
    { from: "sChat", to: "w42" },
    { from: "sChat", to: "w43" },
    { from: "sDb", to: "d41" },
    { from: "sDb", to: "d42" },
    { from: "sDb", to: "d43" },
  ],
  labels: [
    { text: "staging", x: 100, y: 122, tone: "construct" },
    { text: "staging", x: 100, y: 512, tone: "construct" },
  ],
};
const shared: StepSpec[] = [
  chat({
    snippet: "Db.ts",
    file: DB_FILE.file,
    group: DB_FILE.group,
    fontSize: DB_FILE.fontSize,
    title: "But a new database for every pull request starts empty",
    notes:
      "A full copy per PR is great for isolation, but look at the Database Layer: every stage creates a brand new Neon project, with no data in it. Real apps need realistic data to test against, and creating a database per PR is slow and costs money.",
    quiet: true,
  }),
  chat({
    ...DB_FILE,
    title: "A pull request branches staging's database instead",
    notes:
      "For a PR stage, reference staging's project with ref, which reads it from staging's state without owning it, and create a Neon branch in it. A branch is a copy-on-write fork of staging's data, ready in about a second.",
  }),
  chat({
    snippet: "ChatPreview.ts",
    file: WORKER.file,
    group: "preview",
    fontSize: 27,
    regions: ["top", "bottom"],
    title: "The Worker does the same, as a preview of staging's Worker",
    emphasize: ["preview", "Worker.ref"],
    notes:
      "Same idea for the Worker. In a PR stage, it's uploaded as a preview of staging's Worker, with its own URL and its own Durable Object state, instead of a whole new Worker.",
  }),
  {
    kind: "code",
    group: "shared",
    title: "So staging is shared, and every pull request branches off it",
    src: {
      code: `Cloudflare.Worker.ref("Chat", { stage: "staging" })
Neon.Project.ref("Db", { stage: "staging" })`,
    },
    fontSize: 26,
    diagram: SHARED,
    quiet: true,
    frames: 60,
    notes:
      "So staging is the one shared environment. Each PR gets a preview of its Worker and a branch of its database: realistic, isolated, and cheap enough to make for every PR.",
  },
  loop(
    "With its own preview, the pull request is ready to test",
    "Back to the map. The pull request has its own preview now, branched from staging. Next box: test it in CI.",
    ["prTest"],
  ),
  inline({
    group: "ci",
    file: ".github/workflows/pr.yml",
    lang: "yaml",
    fontSize: 30,
    title: "CI runs the same tests against that preview",
    code: PR_YAML,
    emphasize: ["STAGE: pr-", "pnpm test"],
    notes:
      "And CI is one command. For pull request 42, STAGE is pr-42, so pnpm test deploys that preview, with its branched database and its preview Worker, and runs the same tests we ran on our machine against it. Set LOCAL too and CI runs it emulated instead.",
  }),
  term({
    group: "ci-run",
    tabs: ["GitHub Actions · test"],
    title: "pnpm test deploys the preview and tests it",
    lines: [
      $("pnpm test"),
      `${T.ok}${T.bold}▲ deploy${T.reset}   ${T.dim}Chat → stage${T.reset} ${T.bold}pr-42${T.reset}`,
      `  ${T.ok}+ Files  + Messages  + Pool${T.reset}`,
      `  ${T.ok}+ Db${T.reset}    ${T.dim}branch of staging's database${T.reset}`,
      `  ${T.ok}+ Chat${T.reset}  ${T.dim}preview of staging's Worker${T.reset}`,
      ``,
      PASSED,
      ``,
      `${T.ok}1 passed${T.reset}`,
    ],
    notes:
      "In CI it's the same command we ran on our machine. It deploys stage pr-42: the database is a branch of staging's, the Worker is a preview of staging's, and the same test passes against it.",
  }),
  loop(
    "The last step of a pull request is a link to try it",
    "Back to the map. That last box in the pull request lane: a comment with a preview link. The agent can read it, and a reviewer can click it and chat in the preview. So how does that comment get there?",
    ["comment"],
  ),
  chat({
    snippet: "StackPr.ts",
    file: "alchemy.run.ts",
    group: "stack",
    fontSize: 22,
    title: "The Stack comments the preview link on the pull request",
    emphasize: [
      "GitHub.Comment",
      "Config.Int",
      "Config.option",
      "Config.map",
      "if (pullRequest)",
      "owner:",
      "repository:",
      "issueNumber: pullRequest",
      "Preview deployed",
      "GitHub.providers",
    ],
    notes:
      "A GitHub Comment is a resource too. When the Stack deploys for a PR, it posts the preview URL on it, and updates the same comment on every push.",
  }),
  {
    kind: "comment",
    title: "The agent and the reviewer both get a link to try",
    pr: { number: 42, title: "Add file uploads to rooms", branch: "agent/uploads" },
    checks: [{ name: "test", state: "passed", detail: "stage pr-42" }],
    comments: [
      {
        author: "alchemy",
        bot: true,
        lines: ["🚀 Preview deployed to https://pr-42-chat.sam.workers.dev"],
      },
    ],
    notes:
      "The PR shows green tests from its own copy, and a link to try it. The agent can read the check, and a reviewer can click the link and chat in the preview.",
  } satisfies CommentSpec,
  inline({
    group: "ci",
    file: ".github/workflows/pr.yml",
    lang: "yaml",
    fontSize: 24,
    title: "Closing the pull request destroys that copy",
    code: PR_YAML_CLOSE,
    emphasize: ["closed", "cleanup", "alchemy destroy"],
    notes:
      "And when the PR is merged or closed, the copy goes away: destroy that stage, and every resource the PR created goes with it.",
  }),
  term({
    group: "ci-run",
    tabs: ["GitHub Actions · cleanup"],
    title: "alchemy destroy removes everything pr-42 created",
    lines: [
      $("pnpm alchemy destroy --stage pr-42"),
      `${T.red}-${T.reset} ${res("Preview", "GitHub.Comment")} deleted`,
      `${T.red}-${T.reset} ${res("Chat", "Cloudflare.Worker")} deleted ${T.dim}preview of staging's Worker${T.reset}`,
      `${T.red}-${T.reset} ${res("Pool", "Cloudflare.Hyperdrive")} deleted`,
      `${T.red}-${T.reset} ${res("Db", "Neon.Branch")} deleted ${T.dim}branch of staging's database${T.reset}`,
      `${T.red}-${T.reset} ${res("Messages", "Cloudflare.Queues.Queue")} deleted`,
      `${T.red}-${T.reset} ${res("Files", "Cloudflare.R2.Bucket")} deleted`,
      RULE,
      `${T.ok}Stack destroyed (6/6)${T.reset}`,
    ],
    notes:
      "The cleanup job is the same destroy we ran by hand, for stage pr-42: the comment, the preview Worker, the database branch and everything else the pull request created. Staging's Worker and database stay untouched, because the PR only referenced them.",
  }),
];

// ── act 6: main → staging → prod ─────────────────────────────────────────
const MAIN_YAML = `on:
  push:
    branches: [main]

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: pnpm install
      - run: pnpm test
        env: { STAGE: staging }`;
const release: StepSpec[] = [
  loop(
    "Once it's approved, main takes over",
    "The reviewer tried the preview, the checks are green, and the PR is approved. The last lane is main: merge, deploy staging, and run the same tests on it.",
    ["merge", "staging", "stagingTest"],
  ),
  inline({
    group: "main",
    file: ".github/workflows/main.yml",
    lang: "yaml",
    fontSize: 30,
    title: "Merging to main runs the same tests against staging",
    code: MAIN_YAML,
    emphasize: ["branches: [main]", "STAGE: staging"],
    notes:
      "On main, the same command runs with STAGE set to staging. Staging is updated and tested in one step.",
  }),
  loop("Last box: prod, only when staging is green", "And the last box on the map: prod.", [
    "prod",
  ]),
  inline({
    group: "main",
    file: ".github/workflows/main.yml",
    lang: "yaml",
    fontSize: 30,
    title: "Only a green staging reaches prod",
    code: `${MAIN_YAML}
      - run: pnpm alchemy deploy --stage prod`,
    emphasize: ["--stage prod"],
    notes: "And only if those tests pass does the same program deploy to prod.",
  }),
  loop(
    "One program and one test file, all the way to prod",
    "That's the loop. One program describes the whole app. One test file checks it on your machine, emulated or live, on every pull request's copy, and on staging. Every failure along the way is feedback the agent can act on.",
    undefined,
    [
      "edit",
      "types",
      "local",
      "live",
      "push",
      "pr",
      "prTest",
      "comment",
      "merge",
      "staging",
      "stagingTest",
      "prod",
      "feedback",
    ],
  ),
];

// ── anywhere: every provider has the same shape ─────────────────────────
const roll = (s: Omit<RollSpec, "kind">): RollSpec => ({ kind: "roll", ...s });

const HOST_TEMPLATE = `export default ⟨0⟩(
  "Api",
  Effect.gen(function* () {
    return { main: import.meta.url⟨1⟩ };
  }),
  Effect.gen(function* () {
    const files = yield* Files;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        yield* files.upload(request.url, yield* request.text);
        return HttpServerResponse.empty({ status: 201 });
      }),
    };
  }).pipe(Effect.provide(⟨2⟩)),
);`;
const HOSTS = ["Workers", "Lambda", "ECS", "Cloud Run", "GKE", "Fly", "Railway", "Hetzner", "Neon"];
const host = (
  at: number,
  title: string,
  values: string[],
  check: string,
  generated: string,
  notes: string,
) =>
  roll({
    group: "hosts",
    file: "src/Api.ts",
    fontSize: 24,
    title,
    template: HOST_TEMPLATE,
    values,
    check: `anywhere/${check}`,
    beside: { file: "generated at deploy", code: generated },
    reel: { items: HOSTS, at },
    notes,
  });

const JOB_TEMPLATE = `export default ⟨0⟩(
  "Report",
  Effect.gen(function* () {
    return { main: import.meta.url⟨1⟩ };
  }),
  Effect.gen(function* () {
    const files = yield* Files;
    return {
      run: Effect.gen(function* () {
        const report = \`generated at \${new Date().toISOString()}\`;
        yield* files.upload("report.txt", report);
      }),
    };
  }).pipe(Effect.provide(⟨2⟩)),
);`;
const JOBS = ["ECS Task", "Cloud Run Job", "Kubernetes Job"];
const job = (
  at: number,
  title: string,
  values: string[],
  check: string,
  generated: string,
  notes: string,
) =>
  roll({
    group: "jobs",
    file: "src/Report.ts",
    fontSize: 24,
    title,
    template: JOB_TEMPLATE,
    values,
    check: `anywhere/${check}`,
    beside: { file: "generated at deploy", code: generated },
    reel: { items: JOBS, at },
    notes,
  });

const DATABASES = ["Neon", "PlanetScale", "Prisma Postgres", "Cloudflare D1", "AWS Aurora"];

const WEB_TEMPLATE = `export const Web = Effect.gen(function* () {
  const api = yield* Api;

  return yield* ⟨0⟩.Website.⟨1⟩("Web", {
    rootDir: "./apps/web",
    env: { API_URL: api.url.as<string>() },
  });
});`;
const CLOUDS = ["Cloudflare", "AWS", "Fly", "Hetzner", "Railway", "Prisma", "Neon"];
const FRAMEWORKS = [
  "Astro",
  "Nextjs",
  "Nuxt",
  "SvelteKit",
  "ReactRouter",
  "SolidStart",
  "TanStackStart",
  "Vite",
  "Waku",
  "Vocs",
  "Octane",
  "Foldkit",
];
const web = (cloud: string, framework: string, title: string, notes: string) =>
  roll({
    group: "web",
    file: "src/Web.ts",
    fontSize: 40,
    title,
    template: WEB_TEMPLATE,
    values: [cloud, framework],
    check: `anywhere/Web${cloud}${framework === "Astro" ? "" : framework}.ts`,
    reel:
      framework === "Astro"
        ? { items: CLOUDS, at: CLOUDS.indexOf(cloud) }
        : { items: FRAMEWORKS, at: FRAMEWORKS.indexOf(framework) },
    notes,
  });

const OBS_PLATFORMS = ["Axiom", "CloudWatch", "Datadog (someday)"];
const DATADOG_CODE = `export const ObservabilityLive = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("DD_API_KEY");

    // hypothetical: there's no Datadog provider yet
    yield* Datadog.Dashboard("Chat", { widgets: [errors] });
    yield* Datadog.Monitor("Errors", {
      query: "sum(last_5m):errors{service:chat} > 10",
    });

    return Telemetry.layerOtlp({
      url: "https://otlp.datadoghq.com",
      headers: { "dd-api-key": apiKey },
    });
  }),
);`;

const section = (heading: string, subtitle: string, notes: string): StepSpec => ({
  kind: "slide",
  layout: "section",
  title: heading,
  heading,
  subtitle,
  notes,
});

const anywhere: StepSpec[] = [
  {
    kind: "slide",
    layout: "section",
    title: "The same loop, on any cloud",
    heading: "The same loop, on any cloud",
    subtitle: "Every provider has the same shape",
    notes:
      "Everything so far was Cloudflare, with a detour to AWS. But none of it depended on Cloudflare. Let's flip through what else the same program can reach, from the compute up to the website, and watch how little changes.",
  },
  chat({
    snippet: "../anywhere/Files.ts",
    file: "src/Files.ts",
    group: "files-anywhere",
    fontSize: 21,
    title: "Files can have a Layer for each cloud, behind one interface",
    quiet: true,
    notes:
      "Start with Files. Same interface as before, upload a file. Here are three Layers for it: R2, S3 and Google Cloud Storage. Each constructor declares its bucket and the narrowest access its cloud allows.",
  }),
  section(
    "Nine hosts, one API",
    "Workers · Lambda · ECS · Cloud Run · GKE · Fly · Railway · Hetzner · Neon",
    "First, where the code runs. The same API, with the same request handler, on nine different hosts.",
  ),
  host(
    0,
    "The API runs on a Cloudflare Worker…",
    ["Cloudflare.Worker", "", "FilesR2"],
    "ApiWorker.ts",
    `# Worker bindings
r2_buckets:
  - binding: Files
    bucket_name: chat-dev-sam-files`,
    "Here's an API that takes uploads. On a Cloudflare Worker, with the R2 Layer, the bucket is bound straight into the Worker.",
  ),
  host(
    1,
    "…on AWS Lambda…",
    ["AWS.Lambda.Function", "", "FilesS3"],
    "ApiLambda.ts",
    `# IAM policy on the Lambda's role
Effect: Allow
Action: s3:PutObject
Resource: arn:aws:s3:::chat-dev-sam-files/*`,
    "Change the host to a Lambda function and the Layer to S3. The body doesn't change. The binding now becomes an IAM policy, exactly PutObject on exactly this bucket.",
  ),
  host(
    2,
    "…as a container on ECS…",
    ["AWS.ECS.Service", ", cluster: yield* Cluster, port: 3000", "FilesS3"],
    "ApiEcs.ts",
    `# IAM policy on the ECS task role
Effect: Allow
Action: s3:PutObject
Resource: arn:aws:s3:::chat-dev-sam-files/*`,
    "Or a long-running container on ECS. Same S3 Layer, and the same policy, now on the task role instead of the Lambda's.",
  ),
  host(
    3,
    "…on Cloud Run…",
    ["GCP.Run.Service", "", "FilesGCS"],
    "ApiRun.ts",
    `# IAM binding for the service's account
role: roles/storage.objectUser
resource: chat-dev-sam-files`,
    "Google Cloud Run, with Cloud Storage. The binding becomes a Google IAM role on the bucket for the service's account.",
  ),
  host(
    4,
    "…on Kubernetes, in Google Cloud…",
    ["Kubernetes.Deployment", ", cluster: yield* Gke, port: 3000", "FilesGCS"],
    "ApiGke.ts",
    `# IAM binding for the Pod's ServiceAccount
role: roles/storage.objectUser
member: principal://…/sa/api
resource: chat-dev-sam-files`,
    "Or a Kubernetes Deployment on GKE. Same Layer, but now the role goes to the Pod's ServiceAccount through Workload Identity: no keys, no YAML.",
  ),
  host(
    5,
    "…on Fly…",
    ["Fly.Service", "", "FilesTigris"],
    "ApiFly.ts",
    `# Tigris bucket, attached to the Fly app
secrets:
  BUCKET_NAME: chat-dev-sam-files
  AWS_ENDPOINT_URL_S3: https://fly.storage.tigris.dev
  AWS_ACCESS_KEY_ID: tid_…`,
    "Fly, with a Tigris bucket. The binding attaches the bucket to the Fly app and sets its credentials as secrets.",
  ),
  host(
    6,
    "…on Railway…",
    ["Railway.Service", ", project: yield* Chat", "FilesRailway"],
    "ApiRailway.ts",
    `# Railway service variables
BUCKET_NAME: chat-dev-sam-files
AWS_ENDPOINT_URL: https://…
AWS_ACCESS_KEY_ID: …`,
    "Railway, with a Railway bucket. The binding writes the bucket's name and credentials into the service's variables.",
  ),
  host(
    7,
    "…on a Hetzner server, with a mounted volume…",
    ["Hetzner.Service", ", server: yield* Box, port: 3000", "FilesVolume"],
    "ApiHetzner.ts",
    `# systemd unit on the Box server
ExecStart: bun /opt/api/main.js

# Volume attached and mounted
Files → /files (ext4, 10 GB)`,
    "A box you rent from Hetzner. The API runs as a systemd unit, and Files is a Hetzner Volume mounted at /files, so uploads are just files on disk. Same interface, completely different storage.",
  ),
  host(
    8,
    "…or as a Neon Function, and the body never changed",
    ["Neon.Function", ", branch: yield* Main", "FilesNeon"],
    "ApiNeon.ts",
    `# Function environment
AWS_ENDPOINT_URL_S3: https://…neon…
AWS_ACCESS_KEY_ID: …  # scoped to Files`,
    "Or a Neon Function, with a Neon bucket. Nine hosts. The props change, the Files Layer changes, and the request handler never changed once.",
  ),
  section(
    "Three hosts, one background job",
    "ECS Tasks · Cloud Run Jobs · Kubernetes Jobs",
    "Not everything serves requests. Jobs run once and exit, and they have the same shape too.",
  ),
  job(
    0,
    "Background jobs have the same shape, with run instead of fetch",
    ["AWS.ECS.Task", "", "FilesS3"],
    "JobEcs.ts",
    `# IAM policy on the task role
Effect: Allow
Action: s3:PutObject
Resource: arn:aws:s3:::chat-dev-sam-files/*`,
    "Not everything serves requests. A job runs once and exits. Same shape: props, then an Effect that returns run instead of fetch. Here it's an ECS task that writes a report through Files.",
  ),
  job(
    1,
    "…as a Cloud Run Job…",
    ["GCP.Run.Job", "", "FilesGCS"],
    "JobRun.ts",
    `# IAM binding for the job's account
role: roles/storage.objectUser
resource: chat-dev-sam-files`,
    "The same job on Cloud Run Jobs, with Cloud Storage.",
  ),
  job(
    2,
    "…or as a Kubernetes Job",
    ["Kubernetes.Job", ", cluster: yield* Gke", "FilesGCS"],
    "JobGke.ts",
    `# IAM binding for the Job's ServiceAccount
role: roles/storage.objectUser
member: principal://…/sa/report
resource: chat-dev-sam-files`,
    "Or a Kubernetes Job on GKE. Services and jobs, on nine hosts, and it's all the same program.",
  ),
  section(
    "Three engines, one durable workflow",
    "Cloudflare Workflows · Lambda durable functions · Step Functions",
    "Some work takes days and has to survive restarts. Three workflow engines, one way of writing a workflow.",
  ),
  ...[
    {
      snippet: "FlowWorkflow.ts",
      title: "Durable workflows survive restarts and can sleep for days",
      emphasize: ["Cloudflare.Workflow", "Workflows.task", "Workflows.sleep"],
      notes:
        "Some work takes days: summarize a room tonight, wait a day, save the digest. A durable workflow checkpoints each step, so it survives restarts and can sleep for a day without holding a server. On Cloudflare it's a Workflow: task and sleep, each with a name it replays from.",
    },
    {
      snippet: "FlowDurable.ts",
      title: "…on AWS, the same workflow is a Lambda durable function…",
      emphasize: [
        "AWS.Lambda.DurableFunction",
        "Durable.step",
        "Durable.sleep",
        "{ main: import.meta.url }",
        "FilesS3",
      ],
      notes:
        "On AWS it's a Lambda durable function, with almost the same code: step instead of task, and the S3 Files Layer instead of R2. Lambda checkpoints each step and resumes the function after the sleep.",
    },
    {
      snippet: "FlowSfn.ts",
      title: "…or a Step Functions state machine, written as an Effect",
      emphasize: ["StateMachine.fromProgram", "Sfn.gen", "Sfn.invoke", "Sfn.sleep"],
      notes:
        "Or Step Functions. Normally that means hand-writing Amazon States Language JSON. Here it's written like an Effect, with Sfn.gen, Sfn.invoke and Sfn.sleep, and compiled to that JSON at deploy, along with the IAM permissions to invoke each Lambda.",
    },
  ].map((flow, at) =>
    chat({
      snippet: `../anywhere/${flow.snippet}`,
      file: "src/Digest.ts",
      group: "flows",
      fontSize: 24,
      title: flow.title,
      emphasize: flow.emphasize,
      reel: { items: ["Cloudflare Workflows", "Lambda durable functions", "Step Functions"], at },
      notes: flow.notes,
    }),
  ),
  section(
    "Five databases, one Layer",
    "Neon · PlanetScale · Prisma Postgres · Cloudflare D1 · AWS Aurora",
    "Down to the database. Five databases from five companies, all behind the same Database Layer.",
  ),
  ...[
    {
      snippet: "DbNeon.ts",
      title: "The database can be Neon…",
      notes:
        "Down to the database. This is the Database Layer from the chat app, on Neon: a project and a branch, fronted by Hyperdrive.",
    },
    {
      snippet: "DbPlanetscale.ts",
      title: "…PlanetScale…",
      notes:
        "Swap in PlanetScale: a Postgres database and a role. Its origin feeds Hyperdrive the same way.",
    },
    {
      snippet: "DbPrisma.ts",
      title: "…Prisma Postgres…",
      notes: "Or Prisma Postgres. Three different companies, and only the first two lines changed.",
    },
    {
      snippet: "DbD1.ts",
      emphasize: ["D1.Database", "D1.QueryDatabase", "SQL.D1Layer"],
      title: "…Cloudflare D1, which is SQLite…",
      notes:
        "It doesn't even have to be Postgres. Cloudflare D1 is SQLite, bound straight into the Worker with no connection pool, and SQL.D1Layer turns it into the same SQL client. History's queries don't change.",
    },
    {
      snippet: "DbAurora.ts",
      emphasize: ["RDS.Aurora", "RDS.Connect(", "Effect.map(db"],
      title: "…or Aurora on AWS, and nothing above it changes",
      notes:
        "Or Aurora on AWS, for the Lambda version of the app. RDS.Connect grants read access to the cluster's secret and attaches the function to the database's network, and the Postgres Layer connects with the URL it returns. Five databases, one Layer: History and everything above it still just get a SQL client.",
    },
  ].map((db, at) =>
    chat({
      snippet: `../anywhere/${db.snippet}`,
      file: "src/Db.ts",
      group: "db-anywhere",
      fontSize: 22,
      title: db.title,
      reel: { items: DATABASES, at },
      emphasize: "emphasize" in db ? db.emphasize : undefined,
      notes: db.notes,
    }),
  ),
  section(
    "Events from anywhere",
    "GitHub repositories · SQS · Kinesis · DynamoDB Streams",
    "Events don't have to come from your own cloud. Anything that can call a webhook can be an event source.",
  ),
  ...[
    {
      snippet: "EventsGitHub.ts",
      title: "A GitHub repository can be an event source",
      emphasize: ["GitHub.consumeRepositoryEvents", "GitHub.RepositoryEventSourceLive"],
      generated: `# GitHub webhook on alchemy-run/chat
url: https://chat-dev-sam-archive.workers.dev
       /__alchemy/github/alchemy-run/chat
events: [push]
content_type: json
secret: *****

# Worker secret binding, to verify each delivery
WEBHOOK_SECRET=*****`,
      notes:
        "Events don't have to come from a cloud. A GitHub repository is an event source too. You don't manage a secret: at deploy, the binding generates a random one, creates the webhook on the repository pointed at a path on this Worker, and binds the same secret to the Worker, so it can verify every delivery really came from GitHub. Each event is typed by its name.",
    },
    {
      snippet: "EventsSqs.ts",
      emphasize: ["AWS.SQS.Queue", "AWS.SQS.consumeQueueMessages", "QueueEventSource"],
      title: "…an SQS queue on AWS…",
      generated: `# IAM policy on the Lambda's role
- Effect: Allow
  Action:
    - sqs:ReceiveMessage
    - sqs:DeleteMessage
    - sqs:GetQueueAttributes
  Resource: arn:aws:sqs:…:chat-dev-sam-messages

# Event source mapping
FunctionName: chat-dev-sam-archive
EventSourceArn: arn:aws:sqs:…:chat-dev-sam-messages
Enabled: true
BatchSize: 10
FunctionResponseTypes: [ReportBatchItemFailures]
MetricsConfig: { Metrics: [EventCount] }`,
      notes:
        "Back on AWS, event sources all look alike. Consume an SQS queue: the call grants the three consumer permissions and creates the event source mapping that invokes the Lambda.",
    },
    {
      snippet: "EventsKinesis.ts",
      emphasize: ["AWS.Kinesis.Stream", "AWS.Kinesis.consumeStreamRecords", "StreamEventSource"],
      title: "…a Kinesis stream…",
      generated: `# IAM policy on the Lambda's role
- Effect: Allow
  Action:
    - kinesis:DescribeStream
    - kinesis:GetRecords
    - kinesis:GetShardIterator
    - kinesis:ListShards
  Resource: arn:aws:kinesis:…:stream/chat-dev-sam-messages

# Event source mapping
FunctionName: chat-dev-sam-archive
EventSourceArn: arn:aws:kinesis:…:stream/chat-dev-sam-messages
Enabled: true
StartingPosition: LATEST
BatchSize: 100
FunctionResponseTypes: [ReportBatchItemFailures]
MetricsConfig: { Metrics: [EventCount] }`,
      notes:
        "A Kinesis stream: swap the resource and the consume call. The permissions and the mapping change to match, the handler doesn't.",
    },
    {
      snippet: "EventsDynamo.ts",
      emphasize: ["AWS.DynamoDB.Table", "AWS.DynamoDB.consumeTableChanges", "TableEventSource"],
      title: "…or every change to a DynamoDB table",
      generated: `# Table: stream turned on
TableName: chat-dev-sam-messages
StreamSpecification:
  StreamEnabled: true
  StreamViewType: NEW_IMAGE

# IAM policy on the Lambda's role
- Effect: Allow
  Action:
    - dynamodb:DescribeStream
    - dynamodb:GetRecords
    - dynamodb:GetShardIterator
  Resource: arn:aws:dynamodb:…:table/chat-dev-sam-messages/stream/…
- Effect: Allow
  Action: [dynamodb:ListStreams]
  Resource: arn:aws:dynamodb:…:table/chat-dev-sam-messages

# Event source mapping
FunctionName: chat-dev-sam-archive
EventSourceArn: arn:aws:dynamodb:…:table/chat-dev-sam-messages/stream/…
Enabled: true
StartingPosition: LATEST
BatchSize: 100
FunctionResponseTypes: [ReportBatchItemFailures]
MetricsConfig: { Metrics: [EventCount] }`,
      notes:
        "Or every change to a DynamoDB table. This one also changes the table itself: it turns on the table's stream with the view type you asked for, then grants the stream permissions and creates the mapping on the stream's ARN. Four event sources, one shape.",
    },
  ].map((ev, at) =>
    chat({
      snippet: `../anywhere/${ev.snippet}`,
      file: "src/Archive.ts",
      group: "events",
      fontSize: 20,
      title: ev.title,
      emphasize: ev.emphasize,
      beside: { file: "generated at deploy", lang: "yaml", src: { code: ev.generated } },
      reel: { items: ["GitHub", "SQS", "Kinesis", "DynamoDB Streams"], at },
      notes: ev.notes,
    }),
  ),
  section(
    "Seven clouds, one Website",
    "Cloudflare · AWS · Fly · Hetzner · Railway · Prisma · Neon",
    "At the top of the pyramid, the website. We made every Website variant take the same props, so where your site runs is one word, and so is the framework.",
  ),
  web(
    "Cloudflare",
    "Astro",
    "At the top, the chat's website deploys to Cloudflare…",
    "Finally the top of the pyramid: the website. One call deploys an Astro site to Cloudflare, with the API's URL passed in.",
  ),
  web("AWS", "Astro", "…AWS…", "Change the namespace and the same site deploys to AWS."),
  web("Fly", "Astro", "…Fly…", "To Fly."),
  web("Hetzner", "Astro", "…a Hetzner server…", "To a Hetzner box."),
  web("Railway", "Astro", "…Railway…", "To Railway."),
  web("Prisma", "Astro", "…Prisma…", "To Prisma."),
  web(
    "Neon",
    "Astro",
    "…or Neon, with the same props every time",
    "Or Neon. Seven clouds, the same props every time.",
  ),
  web(
    "Neon",
    "Nextjs",
    "The framework is one word too",
    "And the framework is one word too: Next.js…",
  ),
  web("Neon", "Nuxt", "The framework is one word too", "…Nuxt…"),
  web("Neon", "SvelteKit", "The framework is one word too", "…SvelteKit…"),
  web("Neon", "ReactRouter", "…and the rest", "…React Router…"),
  web("Neon", "SolidStart", "…and the rest", "…SolidStart…"),
  web("Neon", "TanStackStart", "…and the rest", "…TanStack Start…"),
  web("Neon", "Vite", "…and the rest", "…Vite…"),
  web("Neon", "Waku", "…and the rest", "…Waku…"),
  web("Neon", "Vocs", "…and the rest", "…Vocs…"),
  web("Neon", "Octane", "…and the rest", "…Octane…"),
  web(
    "Neon",
    "Foldkit",
    "…and the rest",
    "…and Foldkit. Twelve frameworks, same props, and on every cloud alchemy dev runs the framework's own dev server.",
  ),
  section(
    "Three platforms, one observability Layer",
    "Axiom · CloudWatch · Datadog (someday)",
    "Last, the column beside the pyramid. Observability is a Layer like the rest, so the platform behind it is a choice.",
  ),
  ...[
    {
      snippet: "Observability.ts",
      title: "Observability is a Layer, so the platform is one swap away",
      notes:
        "Last, the pillar beside the pyramid. Observability is a Layer like the rest, so the platform behind it is a choice. Here's the Axiom version: datasets, a token, a dashboard, a monitor, and the exporter.",
    },
    {
      snippet: "../anywhere/ObservabilityCloudWatch.ts",
      title: "…CloudWatch plots and alarms on what Lambda already collects…",
      notes:
        "For the Lambda version of the API, it's CloudWatch. Lambda already ships logs and metrics there, so this Layer only declares a CloudWatch dashboard and an alarm on the function's errors.",
    },
  ].map((step, at) =>
    chat({
      snippet: step.snippet,
      file: "src/Observability.ts",
      group: "observability-swap",
      fontSize: 20,
      title: step.title,
      reel: { items: OBS_PLATFORMS, at },
      notes: step.notes,
    }),
  ),
  inline({
    group: "observability-swap",
    file: "src/Observability.ts",
    fontSize: 20,
    title: "…and a Datadog Layer would have exactly the same shape",
    code: DATADOG_CODE,
    emphasize: ["Datadog.Dashboard", "Datadog.Monitor", "Telemetry.layerOtlp"],
    reel: { items: OBS_PLATFORMS, at: 2 },
    notes:
      "Datadog isn't an Alchemy provider yet, so this one is hypothetical. But it would be the same shape: a dashboard and a monitor in the constructor, and an exporter at the end. The exporter part is real today: Telemetry.layerOtlp sends to any OpenTelemetry backend.",
  }),
  chat({
    snippet: "ObservabilityTwo.ts",
    file: "src/Observability.ts",
    group: "observability-two",
    fontSize: 24,
    title: "Layers compose, so telemetry can go to two places at once",
    emphasize: ["Telemetry.layerOtlp", "Layer.mergeAll(Axiom, Honeycomb)"],
    notes:
      "And because they're Layers, they compose. Merge Axiom with a Honeycomb exporter and every span goes to both, with the same trace ids. That's how you migrate between platforms without a gap.",
  }),
  loop(
    "Whatever you pick, it's the same loop",
    "And whichever of these you pick, it's the same program, the same test file, and the same loop from edit to production.",
    undefined,
    [
      "edit",
      "types",
      "local",
      "live",
      "push",
      "pr",
      "prTest",
      "comment",
      "merge",
      "staging",
      "stagingTest",
      "prod",
      "feedback",
    ],
  ),
];

export const steps: StepSpec[] = [
  ...opening,
  ...theStack,
  ...twoPrograms,
  ...modules,
  ...compose,
  ...program,
  ...theLoop,
  ...tests,
  ...ci,
  ...shared,
  ...release,
  ...anywhere,
];
