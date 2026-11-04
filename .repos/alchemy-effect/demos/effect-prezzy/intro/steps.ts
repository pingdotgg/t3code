/**
 * The intro, as authored. Each entry is one press of → in the presenter;
 * `title` is the caption at the bottom of the screen and `notes` is the
 * talk track. `intro/build.ts` resolves this into `out/capture/intro/intro.json`.
 *
 * Code comes from `snippets/` (real files, type-checked; `*.error.ts` must
 * fail and their real errors are shown) or inline `code` for the imagined
 * language. Boards are drawn by `remotion/intro/boards.tsx`.
 */
import type {
  ArchStep,
  BundlePanel,
  DashStep,
  Drill,
  LoopPart,
  MiniGraph,
  PhaseTimeline,
  PanelItem,
  PyramidStep,
  ReqItem,
  ReqPanel,
  Tone,
} from "../shared/intro.ts";
import CLIENTS from "./bundle-clients.json" with { type: "json" };
import { demo } from "./demo.ts";

/** Where in the code: the first match of `text` (or the `nth`, 1-based). */
export type Find = string | { text: string; nth?: number };

/**
 * `regions` picks what's shown (other code collapses to "…"); `omit` drops regions
 * entirely, for building a file up one piece per step from the finished version.
 */
/** `fold` collapses a region to one line, like an editor fold: `first line … last line`. */
export type Source =
  | { snippet: string; regions?: string[]; omit?: string[]; fold?: string[] }
  | { code: string };

export interface CodeSpec {
  kind: "code";
  title: string;
  notes?: string;
  group: string;
  file?: string;
  pseudo?: boolean;
  src: Source;
  lang?: "typescript" | "yaml" | "ansi" | "shellscript" | "json";
  fontSize?: number;
  /** Tint lines by phase: a snippet region, or the lines from one match to another. */
  tints?: (({ region: string } | { from: Find; to?: Find }) & { tone: Tone })[];
  focus?: { from: Find; to?: Find };
  marks?: {
    kind: "circle" | "underline" | "strike" | "box" | "highlight";
    find: Find;
    /** For boxes spanning lines: the last line (found by text). */
    to?: Find;
    label?: string;
    side?: "right" | "left" | "above" | "below";
    tone?: Tone;
    /** Set the label further away, with an arrow pointing at the mark. */
    arrow?: boolean;
  }[];
  /**
   * For `*.error.ts` snippets: which lines of the compiler's message to show,
   * or `hide` to show the (still failing) code before the error is revealed.
   */
  error?: {
    pick?: (lines: string[]) => string[];
    hide?: boolean;
    /** Show the error under the code, so the code keeps the full width. */
    below?: boolean;
  };
  panel?: { title: string; items: PanelItem[] };
  /** A drawing beside the code that evolves with it. */
  diagram?: MiniGraph;
  /** The two phases over time, drawn where the diagram goes. */
  timeline?: PhaseTimeline;
  /** A value passed down a call chain, drawn beside the code. */
  drill?: Drill;
  /** The code's requirements (Effect's Req), listed beside it. */
  req?: ReqPanel;
  /** The Worker's bundle, beside the code. */
  bundle?: BundlePanel;
  /** A second file shown side by side, on the right. */
  beside?: Pick<CodeSpec, "file" | "src" | "lang" | "tints" | "marks">;
  /** Lines from text in this file to text in `beside`. */
  links?: { from: Find; to: Find; tone?: Tone }[];
  /**
   * A third file under this one, on the left, generated from it: an arrow labelled
   * `label` runs down from this file to it, and `links` run from it to `beside`.
   */
  under?: Pick<CodeSpec, "file" | "src" | "lang" | "marks"> & {
    label: string;
    links?: { from: Find; to: Find; tone?: Tone }[];
  };
  /** Arcs from text in the code to a node or an edge's label in `diagram`. */
  diagramLinks?: { from: Find; to: { node: string } | { edge: [string, string] }; tone?: Tone }[];
  /** A hand-written aside in the bottom-right corner. */
  aside?: { text: string; tone?: Tone; image?: string; at?: "left" | "right" };
  /** A big hand-drawn red X across the code: this approach is wrong. */
  cross?: boolean;
  /** Don't highlight or spotlight the lines that changed since the previous step. */
  quiet?: boolean;
  /**
   * Lines to mark in green, by text they contain. Replaces the automatic diff:
   * the green is for drawing the eye, not a faithful patch.
   */
  emphasize?: string[];
  /** A row of options under the code, with the current one lit (as on roll slides). */
  reel?: { items: string[]; at: number };
  /** What the new lines add, in pyramid terms: tints them and labels them. */
  layer?: "resource" | "binding" | "api";
  /** Show lines removed since this file was last on screen, in red, above what replaced them. */
  showRemoved?: boolean;
  frames?: number;
}

export interface SlideSpec {
  kind: "slide";
  title: string;
  notes?: string;
  layout?: "title" | "section";
  eyebrow?: string;
  heading: string;
  subtitle?: string;
  /** Small text pinned to the bottom of a title slide, e.g. a URL. */
  footer?: string;
  frames?: number;
}

export interface BoardSpec {
  kind: "board";
  title: string;
  notes?: string;
  board: string;
  stage: number;
  frames?: number;
}

/** A terminal pane. `lines` is everything shown; `fresh` of them (at the end) are new. */
export interface TerminalSpec {
  kind: "terminal";
  title: string;
  notes?: string;
  group?: string;
  tabs?: string[];
  active?: number;
  lines: string;
  fresh?: number;
  /** A live deploy under the lines (see TerminalStep.progress); `done` is ANSI text. */
  progress?: {
    rows: { name: string; type?: string; binding?: boolean; from: number; to: number }[];
    done: string;
    at: number;
  };
  frames?: number;
}

/** A browser window showing a screenshot from `intro/assets/`. */
export interface BrowserSpec {
  kind: "browser";
  title: string;
  notes?: string;
  url: string;
  image: string;
  frames?: number;
}

/** The whole path from an edit to production, with some parts lit up (loop deck). */
export interface LoopSpec {
  kind: "loop";
  title: string;
  notes?: string;
  /** Parts drawn so far, for building the map up; omit to draw everything. */
  show?: LoopPart[];
  /** Parts shown at full strength; the rest are dimmed. Omit to light everything. */
  lit?: LoopPart[];
  /** Parts that glow: what this step is about. */
  focus?: LoopPart[];
  frames?: number;
}

/** A pull request page with its checks and comments (loop deck). */
export interface CommentSpec {
  kind: "comment";
  title: string;
  notes?: string;
  pr: { number: number; title: string; branch: string };
  checks: { name: string; state: "pending" | "passed" | "failed"; detail?: string }[];
  comments: { author: string; bot?: boolean; lines: string[] }[];
  frames?: number;
}

/** An application's layers as a pyramid (loop deck). */
export type PyramidSpec = Omit<PyramidStep, "notes" | "frames"> & {
  notes?: string;
  frames?: number;
};

/** Code with ⟨0⟩, ⟨1⟩… slots that roll to new values from step to step (loop deck). */
export interface RollSpec {
  kind: "roll";
  group: string;
  title: string;
  notes?: string;
  file?: string;
  fontSize?: number;
  template: string;
  values: string[];
  /** A snippet whose shown code must equal the filled template, so every variant is type-checked. */
  check?: string;
  beside?: { file: string; lang?: "yaml" | "typescript"; code: string };
  reel?: { items: string[]; at: number };
  /**
   * Spin slot `slot` through `through` before landing. Each value is checked like the
   * landing one: `check(value)` names a snippet that must equal the filled template.
   */
  spin?: { slot: number; through: string[]; check?: (value: string) => string };
  frames?: number;
}

/** A full-screen architecture drawing (loop deck). */
export type ArchSpec = Omit<ArchStep, "notes" | "frames"> & { notes?: string; frames?: number };

/** A mocked observability dashboard (loop deck). */
export type DashSpec = Omit<DashStep, "notes" | "frames"> & { notes?: string; frames?: number };

export type StepSpec =
  | DashSpec
  | ArchSpec
  | RollSpec
  | CodeSpec
  | SlideSpec
  | BoardSpec
  | TerminalSpec
  | BrowserSpec
  | LoopSpec
  | CommentSpec
  | PyramidSpec;

/** The compiler's message lines that name the missing requirement. */
const requirementLines = (needle: string) => (lines: string[]) => {
  const at = lines.findIndex((line) => line.includes(needle));
  return at < 0 ? lines.slice(0, 2) : lines.slice(Math.max(1, at - 1), at + 1);
};

// ── Act 1 & 2: one program in an imaginary cloud language ────────────────
// The code on the left grows one idea at a time; the drawing on the right
// shows what that code means in the cloud.
const C = {
  bucket: { id: "bucket", title: "Bucket", color: "#8b7cf6" },
  queue: { id: "queue", title: "Queue", color: "#e0a86b" },
  api: { id: "api", title: "Function", color: "#f38020" },
};
const FN = `

function fetch(req) {
  const file = bucket.get(req.key)
  queue.send(file)
}`;
const VERSIONED = `const bucket = Bucket({ versioning: true })
const queue = Queue()${FN}`;
const COLORED_APP = `construct app() {
  const bucket = Bucket({ versioning: true })
  const queue = Queue()

  runtime function fetch(req) {
    const file = bucket.get(req.key)
    queue.send(file)
  }
}`;
/** What the function needs, inferred from its body the way a type would be. */
const INFERRED_NEEDS = COLORED_APP.replace(
  "  runtime function fetch(req) {",
  "  // needs: s3:GetObject | sqs:SendMessage\n  runtime function fetch(req) {",
);
/** Step one of the colors: only construction is marked. */
const CONSTRUCT_ONLY = COLORED_APP.replace(
  "  runtime function fetch(req) {",
  "  function fetch(req) {",
);
/** The question: what would a bucket created inside the function even mean? */
const SCRATCH = VERSIONED.replace(
  "  const file = bucket.get(req.key)",
  "  const scratch = Bucket()\n  const file = bucket.get(req.key)",
);
/** The mirror mistake, before phases exist: reading the bucket outside the function. */
const EARLY_READ = VERSIONED.replace(
  "const queue = Queue()\n",
  'const queue = Queue()\nconst hello = bucket.get("hello.txt")\n',
);
const SCRATCH_NODE = {
  id: "scratch",
  title: "Bucket?",
  color: "#ff7b72",
  x: 360,
  y: 610,
  ghost: true,
};
const COLORED_BAD = COLORED_APP.replace(
  "    const file = bucket.get(req.key)",
  "    const scratch = Bucket()\n    const file = bucket.get(req.key)",
);

/** The mirror mistake: calling runtime code during construction. */
const COLORED_EARLY = COLORED_APP.replace(
  "  const queue = Queue()\n",
  '  const queue = Queue()\n  bucket.get("hello.txt")\n',
);

const at = (
  node: { id: string; title: string; color: string },
  x: number,
  y: number,
  notes?: string[],
) => ({
  ...node,
  x,
  y,
  ...(notes ? { notes } : {}),
});
/** The program's graph; `env` lists variables injected into the Function. */
const GRAPH = (notes?: string[], env?: string[]) => [
  at(C.api, 125, 270, env),
  at(C.bucket, 590, 100, notes),
  at(C.queue, 590, 440),
];
const USES = [{ from: "api", to: "bucket" }];
/** A binding: the connection carries its permission, and the Function gets an env var. */
const GET = { from: "api", to: "bucket", tone: "construct" as const, label: "s3:GetObject" };
const SEND = { from: "api", to: "queue", tone: "construct" as const, label: "sqs:SendMessage" };
const BINDINGS = [GET, SEND];
const ENV = ["$BUCKET_NAME", "$QUEUE_URL"];
const lang = (
  spec: Omit<CodeSpec, "kind" | "group" | "pseudo" | "fontSize"> & { group?: string },
): CodeSpec => ({
  kind: "code",
  group: "lang",
  pseudo: true,
  fontSize: 32,
  ...spec,
});

const B1 = "const bucket = Bucket()";
const B2 = "const bucket = Bucket({ versioning: true })";
const BQ = `${B2}
const queue = Queue()`;
const EMPTY_FN = `${BQ}

function fetch(req) {
}`;
const GET_FN = `${BQ}

function fetch(req) {
  const file = bucket.get(req.key)
}`;

const program = (): StepSpec[] => [
  lang({
    title: "I wanted one language where a variable could be a cloud resource",
    src: { code: B1 },
    diagram: { nodes: [at(C.bucket, 360, 150)], edges: [] },
    notes:
      "Imagine a programming language for the cloud. Declaring a bucket wouldn't allocate memory: it would create a real bucket in the cloud.",
  }),
  lang({
    title: "Change its configuration, and the cloud would update to match",
    src: { code: B2 },
    diagram: { nodes: [at(C.bucket, 360, 150, ["versioning: on"])], edges: [] },
    notes:
      "Resources have configuration that changes over time. Turn on versioning in the code, and the language would reconcile the real bucket to match.",
  }),
  lang({
    title: "You'd declare a queue the same way",
    src: { code: BQ },
    diagram: {
      nodes: [at(C.bucket, 590, 100, ["versioning: on"]), at(C.queue, 590, 440)],
      edges: [],
    },
    notes: "A queue would be declared just like the bucket: one line, one real queue in the cloud.",
  }),
  lang({
    title: "Unlike variables, these resources would outlive the program",
    src: { code: BQ },
    diagram: {
      nodes: [at(C.bucket, 590, 100, ["versioning: on"]), at(C.queue, 590, 440)],
      edges: [],
      labels: [
        {
          text: "these live in the cloud\nlong after the program runs",
          x: 190,
          y: 262,
          tone: "construct",
          arrows: [
            { from: [300, 220], to: [462, 118] },
            { from: [300, 335], to: [462, 425] },
          ],
        },
      ],
    },
    notes:
      "An ordinary program runs from start to finish and its state is gone. These wouldn't go away when the program ends: they'd be a persistent world, and the next run would start from it.",
  }),
  lang({
    title: "Functions would be resources too",
    src: { code: EMPTY_FN },
    diagram: { nodes: GRAPH(["versioning: on"]), edges: [] },
    notes: "Declaring a function would deploy it: another node in the world.",
  }),
  lang({
    title: "When the function reads the bucket, they'd become connected",
    src: { code: GET_FN },
    diagram: { nodes: GRAPH(["versioning: on"]), edges: [USES[0]!] },
    notes: "Call bucket.get inside the function, and the function would now depend on the bucket.",
  }),
  lang({
    title: "That connection would need permission to read the bucket",
    src: { code: GET_FN },
    diagram: { nodes: GRAPH(["versioning: on"]), edges: [GET] },
    notes:
      "For the function to call bucket.get, it would need an IAM policy that allows s3:GetObject on this bucket.",
  }),
  lang({
    title: "…and the bucket's name, passed in as an environment variable",
    src: { code: GET_FN },
    diagram: { nodes: GRAPH(["versioning: on"], [ENV[0]!]), edges: [GET] },
    notes:
      "And it would need to know which bucket: its name would be injected as an environment variable. The permission plus the configuration is what we call a binding.",
  }),
  lang({
    title: "Sending to the queue would connect them the same way",
    src: { code: VERSIONED },
    diagram: { nodes: GRAPH(["versioning: on"], ENV), edges: BINDINGS },
    notes:
      "Same again for the queue: sqs:SendMessage, and the queue's URL in an environment variable.",
  }),
  lang({
    title: "The language would work all of this out from code",
    src: { code: VERSIONED },
    diagram: { nodes: GRAPH(["versioning: on"]), edges: BINDINGS },
    diagramLinks: [
      { from: "bucket.get(req.key)", to: { edge: ["api", "bucket"] } },
      { from: "queue.send(file)", to: { edge: ["api", "queue"] } },
    ],
    frames: 40,
    notes:
      "A cloud language would derive all of this by static analysis. Nobody would write policies or environment variables by hand: the program would be a graph of resources, and the code would be the source of truth for how they connect.",
  }),
  lang({
    title: "But what if the function created a bucket?",
    src: { code: SCRATCH },
    diagram: {
      nodes: [...GRAPH(["versioning: on"], ENV), SCRATCH_NODE],
      edges: BINDINGS,
      labels: [{ text: "one per request?", x: 590, y: 622, tone: "bad" }],
    },
    notes:
      "So far every resource was declared at the top. What if the function itself declared one? The function runs on every request, maybe thousands of times a second. Would each request get a new bucket? Who would delete them? Who would give the function permission to create them?",
  }),
  lang({
    title: "Uh-oh. Resources need to be known ahead of time",
    src: { code: SCRATCH },
    marks: [{ kind: "strike", find: "Bucket()", tone: "bad" }],
    diagram: {
      nodes: [...GRAPH(["versioning: on"], ENV), SCRATCH_NODE],
      edges: BINDINGS,
      labels: [{ text: "one per request?", x: 590, y: 622, tone: "bad" }],
      cards: [{ text: "✗ not known until a request arrives", tone: "bad" }],
    },
    notes:
      "It wouldn't make sense. Infrastructure has to be created once, ahead of time, by the deploy. The function only uses it. So there would really be two different kinds of code in this program.",
  }),
  lang({
    title: "…and code outside the function has no request to serve",
    src: { code: EARLY_READ },
    quiet: true,
    marks: [{ kind: "strike", find: 'bucket.get("hello.txt")', tone: "bad" }],
    diagram: {
      nodes: GRAPH(["versioning: on"], ENV),
      edges: BINDINGS,
      cards: [{ text: "✗ runs at deploy, not per request", tone: "bad" }],
    },
    notes:
      "And the mirror image. Reading the bucket outside the function would run at deploy time, while the bucket is still being created, with no request and no permissions yet. That doesn't make sense either.",
  }),
  lang({
    title: "So a cloud program is actually a language with two phases",
    src: { code: VERSIONED },
    timeline: { resources: [C.bucket, C.queue, C.api], requests: 5 },
    frames: 60,
    notes:
      "Two phases, one after the other. Construction runs once, at deploy: it creates the bucket, the queue and the function, and they live on. Then runtime: the function body runs on every request, reading the bucket and sending to the queue, using what construction made.",
  }),
  lang({
    title: "One for construction, containing the resource declarations",
    src: { code: CONSTRUCT_ONLY },
    tints: [{ from: "const bucket", to: "const queue", tone: "construct" }],
    diagram: {
      nodes: GRAPH(["versioning: on"], ENV),
      edges: BINDINGS,
      frame: { label: "construction", tone: "construct" },
    },
    notes:
      "In a real language we'd make the phases explicit. First, construction: a construct function runs once, at deploy time, and everything it declares becomes infrastructure.",
  }),
  lang({
    title: "One for runtime, where those resources implement the API",
    src: { code: COLORED_APP },
    tints: [{ from: "const file", to: "queue.send(file)", tone: "runtime" }],
    diagram: {
      nodes: GRAPH(["versioning: on"], ENV),
      edges: BINDINGS,
      frame: { label: "construction", tone: "construct" },
      incoming: { to: "api", label: "runtime · each request", tone: "runtime" },
    },
    notes:
      "Then runtime: a runtime function inside it runs on every request, using the resources construction declared. These are colored functions: construct and runtime are different colors, and the compiler knows which is which.",
  }),
  lang({
    title: "Now creating a bucket at runtime is a compile error",
    src: { code: COLORED_BAD },
    marks: [{ kind: "strike", find: "Bucket()", tone: "bad" }],
    diagram: {
      nodes: GRAPH(["versioning: on"], ENV),
      edges: BINDINGS,
      cards: [{ text: "✗ can't create a resource at runtime", tone: "bad" }],
    },
    notes:
      "The colors are boundaries the compiler enforces. The mistake from before, creating a bucket inside a request, is now a compile error instead of a question.",
  }),
  lang({
    title: "…and so is reading the bucket during construction",
    src: { code: COLORED_EARLY },
    quiet: true,
    marks: [{ kind: "strike", find: 'bucket.get("hello.txt")', tone: "bad" }],
    diagram: {
      nodes: GRAPH(["versioning: on"], ENV),
      edges: BINDINGS,
      cards: [{ text: "✗ can't call runtime code at deploy time", tone: "bad" }],
    },
    notes:
      "And the rule goes both ways. Reading the bucket is runtime code, and construction runs at deploy time, before there's any request to serve. So calling bucket.get there is a compile error too.",
  }),
  lang({
    title: "And inferring permissions becomes a kind of type checking",
    src: { code: COLORED_APP },
    quiet: true,
    diagram: { nodes: GRAPH(["versioning: on"], ENV), edges: BINDINGS },
    diagramLinks: [
      { from: "bucket.get(req.key)", to: { edge: ["api", "bucket"] } },
      { from: "queue.send(file)", to: { edge: ["api", "queue"] } },
    ],
    frames: 40,
    notes:
      "And working out those permissions is a kind of type checking. Each call in the runtime function tells you something it needs: bucket.get needs s3:GetObject on that bucket, queue.send needs sqs:SendMessage on that queue.",
  }),
  lang({
    title: "…just as a compiler infers a type from a function's body",
    src: { code: INFERRED_NEEDS },
    quiet: true,
    marks: [{ kind: "box", find: "// needs: s3:GetObject | sqs:SendMessage", tone: "construct" }],
    diagram: {
      nodes: GRAPH(["versioning: on"], ENV),
      edges: BINDINGS,
      labels: [{ text: "for every possible req…", x: 360, y: 530, tone: "runtime" }],
    },
    diagramLinks: [
      { from: "bucket.get(req.key)", to: { edge: ["api", "bucket"] } },
      { from: "queue.send(file)", to: { edge: ["api", "queue"] } },
    ],
    notes:
      "A compiler infers a function's return type by looking at every path through its body. Do the same with the calls, and you infer what the function needs: s3:GetObject and sqs:SendMessage, for every possible request. Its permissions become part of its type, and the policy falls out of type checking.",
  }),
];

const PUNCHCARD = `const topic = new SNS.Topic(stack, 'Topic', {
  shape: NotificationRecord
});

new Lambda.Function(stack, 'MyFunction', {
  depends: topic,
}, async (event, topic) => {
  await topic.publish(new NotificationRecord({
    key: 'some key',
    count: 1,
    timestamp: new Date()
  }));
});`;

/** Functionless, simplified: no dependency list, the body is read instead. */
const FUNCTIONLESS = `const table = new Table(stack, "Todos");

new Function(stack, "Delete", async (id: string) => {
  await table.delete({ id });
});`;

/** A Function built around a callback it can't see inside, typed as `type`. */
const deleter = (type: string) => `function deleter(remove: (id: string) => ${type}) {
  return new Function(stack, "Delete", async (id: string) => {
    await remove(id);
  });
}`;

/** The Worker's requirements, listed beside its code. */
const REQ_LABEL = "Req · what it needs";
const BUCKET: ReqItem = { name: "R2.BucketProvider", note: "to create the bucket" };
const READ: ReqItem = { name: "R2.ReadBucket", note: "to read it at runtime" };
const WORKER_PROVIDER: ReqItem = {
  name: "Cloudflare.WorkerProvider",
  note: "to deploy the Worker",
};
const QUEUE: ReqItem = { name: "Queues.QueueProvider", note: "to create the queue" };
const WRITE_LOGS: ReqItem = { name: "R2.WriteBucket", note: "only in dev" };
const WRITE: ReqItem = { name: "Queues.WriteQueue", note: "to send at runtime" };
const met = (item: ReqItem, note: string): ReqItem => ({ ...item, state: "met", note });
const WORKER: ReqItem = { name: "Cloudflare.Worker", note: "native bindings run inside a Worker" };
const PHANTOM: ReqItem = {
  name: "RuntimeContext",
  state: "met",
  note: "RuntimeContext.phantom\nopted out, in plain sight",
};
/** Everything the Worker version of the program needs, with the bindings provided. */
const PROVIDED: ReqItem[] = [
  met(READ, "ReadBucketBinding\nadds a native R2 binding"),
  met(WRITE, "WriteQueueBinding\nadds a native Queue binding"),
  met(WORKER, "it runs in a Worker"),
];

/** The Worker with a hypothetical catch-all layer: not a real API. */
const ALL_BINDINGS = `export default Cloudflare.Worker(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* R2.Bucket("Uploads");
    const uploads = yield* R2.ReadBucket(bucket);
    const queue = yield* Queues.Queue("Jobs");
    const jobs = yield* Queues.WriteQueue(queue);
    return {
      fetch: Effect.gen(function* () {
        const file = yield* uploads.get("hello.txt");
        yield* jobs.send({ size: file?.size });
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(
    Effect.provide([
      R2.AllBindings,
      Queues.AllBindings,
    ]),
  ),
);`;

/** The Lambda in AWS calling R2 and Queues in Cloudflare through a scoped token. */
const CROSS_CLOUD = (connected: boolean): MiniGraph => ({
  nodes: [
    at({ id: "api", title: "Lambda", color: "#ff9900" }, 125, 270),
    at({ id: "bucket", title: "R2 Bucket", color: "#f38020" }, 560, 100),
    at({ id: "queue", title: "Queue", color: "#f38020" }, 560, 440),
  ],
  edges: connected
    ? [
        { from: "api", to: "bucket", tone: "construct", label: "R2: read" },
        { from: "api", to: "queue", tone: "construct", label: "Queues: write" },
      ]
    : [],
  labels: [
    { text: "AWS", x: 125, y: 190, tone: "neutral" },
    { text: "Cloudflare", x: 560, y: 25, tone: "neutral" },
    { text: "🔒 scoped API token,\nbound as a secret", x: 110, y: 400, tone: "construct" },
  ],
});

/** The first line of the compiler's message that starts with `prefix`. */
const firstLine = (prefix: string) => (lines: string[]) =>
  lines.filter((line) => line.startsWith(prefix)).slice(0, 1);

/** One version of the Api Worker, `snippets/api-*.ts`, with its Req beside it. */
const api = (s: {
  title: string;
  /** A type-checked `snippets/api-*.ts`, or inline code for an idea that was never shipped. */
  snippet?: string;
  code?: string;
  notes: string;
  req: ReqItem[];
  /** Req of the runtime function, when it has its own. */
  fetchReq?: ReqItem[];
  tints?: CodeSpec["tints"];
  marks?: CodeSpec["marks"];
  error?: CodeSpec["error"];
  quiet?: boolean;
  emphasize?: string[];
  bundle?: BundlePanel;
  frames?: number;
  aside?: CodeSpec["aside"];
  cross?: boolean;
}): CodeSpec => ({
  kind: "code",
  group: "api",
  file: "src/Api.ts",
  title: s.title,
  src: s.snippet ? { snippet: s.snippet, regions: ["show"] } : { code: s.code! },
  tints: s.tints,
  marks: s.marks,
  error: s.error,
  quiet: s.quiet,
  emphasize: s.emphasize,
  aside: s.aside,
  cross: s.cross,
  bundle: s.bundle,
  frames: s.frames,
  req: s.bundle
    ? undefined
    : {
        label: REQ_LABEL,
        items: s.req,
        parts: s.fetchReq ? [{ label: "fetch's Req", items: s.fetchReq }] : undefined,
      },
  notes: s.notes,
});

// My first attempt: infer the binding from how the bucket is used, the way
// the imaginary language did. Never shipped, so it isn't type-checked.
const INFERRED = `const api = Effect.gen(function* () {
  const bucket = yield* R2.Bucket("Uploads");
  return {
    fetch: Effect.gen(function* () {
      const file = yield* bucket.get("hello.txt");
      return HttpServerResponse.text("ok");
    }),
  };
});`;
const INFERRED_ON_FETCH = `const api = Effect.gen(function* () {
  const bucket = yield* R2.Bucket("Uploads");
  return {
    fetch: Effect.gen(function* () {
      const file = yield* bucket.get("hello.txt");
      return HttpServerResponse.text("ok");
    }).pipe(Effect.provide(R2.ReadBucket(bucket))),
  };
});`;
const INFERRED_HOISTED = `const Uploads = R2.Bucket("Uploads");

const api = Effect.gen(function* () {
  const bucket = yield* Uploads;
  return {
    fetch: Effect.gen(function* () {
      const file = yield* bucket.get("hello.txt");
      return HttpServerResponse.text("ok");
    }),
  };
}).pipe(Effect.provide(R2.ReadBucket(Uploads)));`;
const INFERRED_DEV = `const Uploads = R2.Bucket("Uploads");
const Logs = R2.Bucket("Logs");

const api = Effect.gen(function* () {
  const bucket = yield* Uploads;
  const logs = dev ? yield* Logs : undefined;
  return {
    fetch: Effect.gen(function* () {
      const file = yield* bucket.get("hello.txt");
      if (logs) yield* logs.put("last-read", file);
      return HttpServerResponse.text("ok");
    }),
  };
}).pipe(Effect.provide([R2.ReadBucket(Uploads), R2.WriteBucket(Logs)]));`;
const HOIST_TYPE = `type Hoisted<A> =
  A extends { fetch: Effect<any, any, infer R> } ? R : never;`;
const INFERRED_DEV_2 = INFERRED_DEV.replace(
  "Effect.provide([R2.ReadBucket(Uploads), R2.WriteBucket(Logs)])",
  "Effect.provide(R2.ReadBucket(Uploads))",
);
const PUT_LOGS: ReqItem = { name: "R2.PutObject<Logs>", note: "hoisted out of fetch's type" };
const GET_OBJECT: ReqItem = { name: "R2.GetObject<Uploads>", note: "inferred from bucket.get" };
const GET_OBJECT_HOISTED = met(
  { name: "R2.GetObject<Uploads>" },
  "R2.ReadBucket(Uploads)\ngrants s3:GetObject at deploy",
);

// The last problem: a service's interface can't hide which implementation it has.
const SERVICE = `class Storage extends Context.Service<Storage, {
  get(key: string): Effect<File, NotFound>;
}>()("Storage") {}`;
/** The idiomatic Effect Layer: yield dependencies in the body, return methods that close over them. */
const STORAGE_LIVE = `const StorageLive = Layer.effect(
  Storage,
  Effect.gen(function* () {
    const db = yield* Database;
    return {
      get: (key) => db.get(key),
    };
  }),
);`;
/** The same thing as a class: the constructor takes the dependency, the methods use it. */
const STORAGE_CLASS = `class StorageImpl {
  constructor(private db: Database) {}

  get(key: string) {
    return this.db.get(key);
  }
}`;
const SERVICE_R2 = SERVICE.replace(
  "Effect<File, NotFound>",
  "Effect<File, NotFound, R2.GetObject<Uploads>>",
);
const STORAGE_R2 = `const StorageR2 = Layer.effect(Storage, Effect.gen(function* () {
  const bucket = yield* R2.Bucket("Uploads");
  return { get: (key) => bucket.get(key) };
}));`;
const STORAGE_S3 = `const StorageS3 = Layer.effect(Storage, Effect.gen(function* () {
  const bucket = yield* S3.Bucket("Files");
  return { get: (key) => bucket.get(key) };
}));`;

// ── Act 0: infrastructure as code, and why combine it with runtime code ──
const CFN = `Conditions:
  IsProd: !Equals [!Ref Stage, prod]
Resources:
  Uploads:
    Type: AWS::S3::Bucket
  ApiRole:
    Type: AWS::IAM::Role
    Properties:
      Policies:
        - PolicyName: uploads
          PolicyDocument:
            Statement:
              - Effect: Allow
                Action: [s3:GetObject, s3:PutObject]
                Resource: !Sub "\${Uploads.Arn}/*"
  Api:
    Type: AWS::Lambda::Function
    Properties:
      Handler: index.handler
      Role: !GetAtt ApiRole.Arn
      MemorySize: !If [IsProd, 1024, 256]
      Environment:
        Variables:
          BUCKET_NAME: !Ref Uploads`;
const CDK = `class Api extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);
    const uploads = new s3.Bucket(this, "Uploads");
    const fn = new lambda.Function(this, "Fn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset("dist"),
      environment: {
        BUCKET_NAME: uploads.bucketName,
      },
    });
    uploads.grantReadWrite(fn);
  }
}`;
const HANDLER = `const s3 = new S3Client({});

export const handler = async (event) => {
  await s3.send(new PutObjectCommand({
    Bucket: process.env.BUCKET_NAME,
    Key: event.key,
    Body: event.body,
  }));
};`;
/** Roughly what `cdk synth` emits for the Api construct (logical IDs get hashes). */
const CDK_SYNTH = `Resources:
  Uploads1E2F3A4B:
    Type: AWS::S3::Bucket
  FnServiceRoleB9001A96:
    Type: AWS::IAM::Role
  FnServiceRoleDefaultPolicy:
    Type: AWS::IAM::Policy
    Properties:
      PolicyDocument:
        Statement:
          - Action: [s3:GetObject*, s3:PutObject*]
            Resource: !Sub "\${Uploads1E2F3A4B.Arn}/*"
  Fn9270CBC0:
    Type: AWS::Lambda::Function
    Properties:
      Handler: index.handler
      Environment:
        Variables:
          BUCKET_NAME: !Ref Uploads1E2F3A4B`;
const CDK_LINKS: NonNullable<CodeSpec["links"]> = [
  { from: '"index.handler"', to: "export const handler" },
  { from: "BUCKET_NAME", to: "process.env.BUCKET_NAME" },
  { from: "grantReadWrite", to: "PutObjectCommand" },
];

// ── terminal output, in the CLI's own colors ─────────────────────────────
const T = {
  ok: "\x1b[38;5;113m",
  soft: "\x1b[38;5;150m",
  accent: "\x1b[38;5;173m",
  grey: "\x1b[38;5;102m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};
const RULE = `${T.grey}${T.dim}${"─".repeat(46)}${T.reset}`;
const DEPLOY_PLAN = [
  `${T.dim}$${T.reset} alchemy deploy`,
  `${T.ok}✓${T.reset} Plan ready ${T.dim}(0.8s)${T.reset}`,
  RULE,
  `${T.accent}${T.bold}Deploy${T.reset}${T.dim} · ${T.reset}${T.ok}3 to create${T.reset}${T.dim} · ${T.reset}${T.soft}2 bindings${T.reset}`,
  ``,
  `${T.ok}+${T.reset} ${T.ok}${T.bold}Uploads${T.reset} ${T.dim}(Cloudflare.R2.Bucket)${T.reset}`,
  `${T.ok}+${T.reset} ${T.ok}${T.bold}Jobs${T.reset} ${T.dim}(Cloudflare.Queues.Queue)${T.reset}`,
  `${T.ok}+${T.reset} ${T.ok}${T.bold}Api${T.reset} ${T.dim}(Cloudflare.Worker)${T.reset}`,
  `  ${T.ok}+${T.reset} ${T.soft}Uploads${T.reset}`,
  `  ${T.ok}+${T.reset} ${T.soft}Jobs${T.reset}`,
  RULE,
  `${T.bold}Deploy?${T.reset}  ${T.accent}${T.bold}› Deploy${T.reset}  ${T.dim}Cancel${T.reset}`,
].join("\n");
const DEPLOY_APPLIED = [
  `${T.dim}$${T.reset} alchemy deploy`,
  `${T.ok}✓${T.reset} Plan ready ${T.dim}(0.8s)${T.reset}`,
  RULE,
  `${T.accent}${T.bold}Plan${T.reset}${T.dim} · ${T.reset}${T.ok}3 created${T.reset}`,
  ``,
  `${T.ok}✓${T.reset} ${T.bold}Uploads${T.reset} ${T.dim}(Cloudflare.R2.Bucket)${T.reset} created ${T.dim}(1.2s)${T.reset}`,
  `${T.ok}✓${T.reset} ${T.bold}Jobs${T.reset} ${T.dim}(Cloudflare.Queues.Queue)${T.reset} created ${T.dim}(1.9s)${T.reset}`,
  `${T.ok}✓${T.reset} ${T.bold}Api${T.reset} ${T.dim}(Cloudflare.Worker)${T.reset} created ${T.dim}(6.4s)${T.reset}`,
  `  ${T.ok}✓${T.reset} ${T.soft}Uploads${T.reset} created`,
  `  ${T.ok}✓${T.reset} ${T.soft}Jobs${T.reset} created`,
  RULE,
  `${T.ok}Stack deployed (3/3)${T.reset} ${T.dim}{ url: "https://api.workers.dev" }${T.reset}`,
].join("\n");

// The Stack, built up one piece at a time; the last version is snippets/stack.ts.
const STACK_1 = `export default Alchemy.Stack(
  "App",
);`;
const STACK_2 = `export default Alchemy.Stack(
  "App",
  {
    providers: Cloudflare.providers(),
  },
);`;
const STACK_3 = `export default Alchemy.Stack(
  "App",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
);`;
const STACK_4 = `export default Alchemy.Stack(
  "App",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
  }),
);`;
/** The same Stack deployed to two stages: the same resources, twice, isolated by name. */
const stageColumn = (stage: string, x: number) => [
  at({ id: `api-${stage}`, title: "Api", color: "#f38020" }, x, 130, [`${stage}-api`]),
  at({ id: `uploads-${stage}`, title: "Uploads", color: "#8b7cf6" }, x, 280, [`${stage}-uploads`]),
  at({ id: `jobs-${stage}`, title: "Jobs", color: "#e0a86b" }, x, 430, [`${stage}-jobs`]),
];
const STAGES: MiniGraph = {
  nodes: [...stageColumn("dev", 140), ...stageColumn("prod", 530)],
  edges: [],
  groups: [
    { label: "dev", nodes: ["api-dev", "uploads-dev", "jobs-dev"], tone: "runtime" },
    { label: "prod", nodes: ["api-prod", "uploads-prod", "jobs-prod"], tone: "good" },
  ],
};

/** One step of building the Stack in alchemy.run.ts. */
const stack = (s: {
  title: string;
  code: string;
  notes: string;
  marks?: CodeSpec["marks"];
  panel?: CodeSpec["panel"];
  diagram?: MiniGraph;
  req?: ReqItem[];
}): CodeSpec => ({
  kind: "code",
  group: "stack",
  file: "alchemy.run.ts",
  title: s.title,
  src: { code: s.code },
  marks: s.marks,
  panel: s.panel,
  diagram: s.diagram,
  req: s.req ? { label: REQ_LABEL, items: s.req } : undefined,
  notes: s.notes,
});

// ── what infrastructure as code is ──────────────────────────────────────
const SCRIPT = `aws s3api create-bucket --bucket uploads
aws s3api put-bucket-versioning --bucket uploads \\
  --versioning-configuration Status=Enabled`;
const SCRIPT_IF = `if ! aws s3api head-bucket --bucket uploads; then
  aws s3api create-bucket --bucket uploads
fi
aws s3api put-bucket-versioning --bucket uploads \\
  --versioning-configuration Status=Enabled`;
const SCRIPT_IFS = `if ! aws s3api head-bucket --bucket uploads; then
  aws s3api create-bucket --bucket uploads
fi
status=$(aws s3api get-bucket-versioning --bucket uploads \\
  --query Status --output text)
if [ "$status" != "Enabled" ]; then
  aws s3api put-bucket-versioning --bucket uploads \\
    --versioning-configuration Status=Enabled
fi`;
const CFN_1 = `Resources:
  Uploads:
    Type: AWS::S3::Bucket`;
const CFN_2 = `Resources:
  Uploads:
    Type: AWS::S3::Bucket
    Properties:
      VersioningConfiguration:
        Status: Enabled`;
/** One step of the infrastructure-as-code primer: a file beside the cloud it describes. */
const iac = (s: {
  title: string;
  lang: CodeSpec["lang"];
  file: string;
  code: string;
  notes: string;
  diagram: MiniGraph;
  marks?: CodeSpec["marks"];
}): CodeSpec => ({
  kind: "code",
  group: "iac",
  file: s.file,
  lang: s.lang,
  title: s.title,
  src: { code: s.code },
  marks: s.marks,
  diagram: s.diagram,
  fontSize: 32,
  notes: s.notes,
});

// ── the Worker bundle, for the tree-shaking steps ──────────────────────
const BUNDLE_LABEL = "the Worker bundle";
const USED_CLIENTS = ["get", "send"];
const PRECISE: BundlePanel = {
  label: BUNDLE_LABEL,
  size: 38,
  items: USED_CLIENTS,
  used: USED_CLIENTS,
  note: "just what the code calls",
};
/** Every R2, Queues and S3-compatible operation distilled knows about. */
const EVERYTHING: BundlePanel = {
  label: BUNDLE_LABEL,
  size: 1840,
  items: CLIENTS,
  used: USED_CLIENTS,
  note: "{extra} clients the code never calls",
};

/** The build-up to Effect: write what fetch needs into its type. */
const TYPED = (type: string) =>
  COLORED_APP.replace(
    "  runtime function fetch(req) {",
    `  runtime function fetch(req): ${type} {`,
  );
const typedFetch: StepSpec[] = [
  lang({
    title: "So write what it needs into its type",
    src: { code: TYPED("Promise<Response, never, s3:GetObject>") },
    emphasize: ["runtime function fetch"],
    notes:
      "So write it down, as a third type parameter: fetch returns a Response and needs s3:GetObject. Once it's in the type, nothing has to read the body: anything that calls fetch inherits that need, like any other type.",
  }),
  lang({
    title: "It could say how it fails too, that seems like a good idea 😏",
    src: { code: TYPED("Promise<Response, NotFound, s3:GetObject>") },
    emphasize: ["runtime function fetch"],
    notes: "And while we're at it, the middle parameter could say how it fails: NotFound.",
  }),
  lang({
    title: "Wait… this looks familiar",
    src: { code: TYPED("Effect<Response, NotFound, s3:GetObject>") },
    emphasize: ["runtime function fetch"],
    notes: "Wait. What it returns, how it fails, and what it needs. We've seen this before.",
  }),
];

/** Every step ever written, in the original long order. `steps` below picks from it. */
const allSteps: StepSpec[] = [
  // Act 1: a programming language for the cloud
  {
    kind: "slide",
    layout: "title",
    title: "A programming language for the cloud",
    eyebrow: "Alchemy",
    heading: "A programming language for the cloud",
    subtitle: "…without building a new language",
    notes:
      "The idea underneath Alchemy: a programming language for the cloud, without actually building a new language.",
  },

  {
    kind: "slide",
    layout: "section",
    title: "What is infrastructure as code?",
    eyebrow: "In case you're new to it",
    heading: "What is infrastructure as code?",
    notes: "For anyone who hasn't used it, a quick primer on infrastructure as code.",
  },
  iac({
    title: "Without it, you change the cloud by running scripts",
    lang: "shellscript",
    file: "setup.sh",
    code: SCRIPT,
    diagram: { nodes: [], edges: [] },
    notes:
      "Without infrastructure as code, you change the cloud by running commands: create this bucket, then turn on versioning. A script of steps, run in order.",
  }),
  iac({
    title: "…but running it a second time fails",
    lang: "shellscript",
    file: "setup.sh",
    code: SCRIPT,
    marks: [
      {
        kind: "underline",
        find: "create-bucket",
        label: "the bucket already exists",
        side: "right",
        tone: "bad",
      },
    ],
    diagram: { nodes: [at(C.bucket, 360, 150, ["versioning: on"])], edges: [] },
    notes: "Run it again and create-bucket fails, because the bucket already exists.",
  }),
  iac({
    title: "You have to check what already exists first…",
    lang: "shellscript",
    file: "setup.sh",
    code: SCRIPT_IF,
    diagram: { nodes: [at(C.bucket, 360, 150, ["versioning: on"])], edges: [] },
    notes: "So you add a check: only create the bucket if it isn't there yet.",
  }),
  iac({
    title: "…for every single setting, and it never stops",
    lang: "shellscript",
    file: "setup.sh",
    code: SCRIPT_IFS,
    diagram: { nodes: [at(C.bucket, 360, 150, ["versioning: on"])], edges: [] },
    notes:
      "And then for versioning, and then for every other setting, and every change after that. Every script ends up re-discovering the current state of the world, one if statement at a time.",
  }),
  iac({
    title: "Infrastructure as code declares what should be, not what is",
    lang: "yaml",
    file: "template.yaml",
    code: CFN_1,
    diagram: { nodes: [], edges: [] },
    notes:
      "Infrastructure as code inverts this. You stop tracking what is, and declare what the cloud should be: the desired state. This is CloudFormation, AWS's version. One bucket.",
  }),
  iac({
    title: "An engine compares it to the cloud, and creates what's missing",
    lang: "yaml",
    file: "template.yaml",
    code: CFN_1,
    diagram: {
      nodes: [at(C.bucket, 360, 150)],
      edges: [],
      labels: [{ text: "created", x: 470, y: 90, tone: "good" }],
    },
    notes:
      "An engine compares the desired state with what actually exists. The bucket doesn't exist yet, so the engine creates it.",
  }),
  iac({
    title: "Change what it should be…",
    lang: "yaml",
    file: "template.yaml",
    code: CFN_2,
    diagram: { nodes: [at(C.bucket, 360, 150)], edges: [] },
    notes:
      "Now we want versioning. We don't write a script to turn it on. We just change the description.",
  }),
  iac({
    title: "…and the engine updates only what changed",
    lang: "yaml",
    file: "template.yaml",
    code: CFN_2,
    diagram: {
      nodes: [at(C.bucket, 360, 150, ["versioning: on"])],
      edges: [],
      labels: [{ text: "updated in place", x: 470, y: 90, tone: "good" }],
    },
    notes:
      "Deploy again, and the engine works out the difference: the bucket exists, but versioning is off. It turns versioning on and leaves everything else alone. You say what, the engine works out how. That's infrastructure as code.",
  }),

  // Act 0: why combine infrastructure and runtime code at all
  {
    kind: "code",
    group: "cfn",
    file: "template.yaml",
    lang: "yaml",
    title: "I started out writing CloudFormation templates like this",
    src: { code: CFN },
    notes:
      "That's how I started: writing CloudFormation templates for real apps, a bucket, a role, a Lambda function, all in YAML.",
  },
  {
    kind: "code",
    group: "cfn",
    file: "template.yaml",
    lang: "yaml",
    title: "…but I never liked trying to program in YAML",
    src: { code: CFN },
    marks: [
      {
        kind: "circle",
        find: "!If [IsProd, 1024, 256]",
        label: "an if statement, in YAML",
        side: "right",
        tone: "bad",
      },
      {
        kind: "underline",
        find: '!Sub "${Uploads.Arn}/*"',
        label: "string templating for references",
        side: "right",
        tone: "bad",
      },
    ],
    notes:
      "But I never liked it. I'm a coder. I don't want to write config files, and I really don't want to program in YAML: conditions, string substitution, intrinsic functions.",
  },
  {
    kind: "code",
    group: "cdk",
    file: "infra/api.ts",
    title: "Then the AWS CDK came out",
    src: { code: CDK },
    notes: "Then the AWS CDK came out. The same infrastructure, as a TypeScript class.",
  },
  {
    kind: "code",
    group: "cdk",
    file: "infra/api.ts",
    title: "Finally, I could configure infrastructure with real code",
    src: { code: CDK },
    marks: [
      {
        kind: "underline",
        find: "uploads.grantReadWrite(fn);",
        label: "the whole IAM policy",
        side: "right",
        tone: "good",
      },
    ],
    notes:
      "Finally, real code: variables, functions, types, and abstractions like grantReadWrite that write the IAM policy for you.",
  },
  {
    kind: "code",
    group: "cdk",
    file: "infra/api.ts",
    title: "…or so I thought. The CDK just generated CloudFormation",
    src: { code: CDK },
    beside: { file: "cdk synth → template.yaml", lang: "yaml", src: { code: CDK_SYNTH } },
    links: [
      { from: 'new s3.Bucket(this, "Uploads")', to: "Uploads1E2F3A4B:" },
      { from: "uploads.grantReadWrite(fn);", to: "FnServiceRoleDefaultPolicy:" },
      { from: '"index.handler"', to: "Handler: index.handler" },
    ],
    frames: 45,
    notes:
      "Or so I thought. It's worth being clear about what the CDK actually is. Run cdk synth and your TypeScript executes once, on your machine, and spits out a CloudFormation template. Every construct becomes a block of YAML. That template is what actually gets deployed.",
  },
  {
    kind: "code",
    group: "cdk",
    file: "infra/api.ts",
    title: "It's a template generator, not programmable infrastructure",
    src: { code: CDK },
    marks: [
      {
        kind: "underline",
        find: "class Api extends Construct",
        label: "runs once, at synth",
        side: "right",
        tone: "neutral",
      },
    ],
    beside: {
      file: "cdk synth → template.yaml",
      lang: "yaml",
      src: { code: CDK_SYNTH },
      marks: [
        {
          kind: "underline",
          find: "Resources:",
          label: "what's actually deployed",
          side: "right",
          tone: "construct",
        },
      ],
    },
    links: [
      { from: 'new s3.Bucket(this, "Uploads")', to: "Uploads1E2F3A4B:" },
      { from: "uploads.grantReadWrite(fn);", to: "FnServiceRoleDefaultPolicy:" },
      { from: '"index.handler"', to: "Handler: index.handler" },
    ],
    notes:
      "So it's a much nicer way to write the template, but it's still a template generator. The code is gone by the time anything deploys. Anything that depends on the real cloud at deploy time is back to CloudFormation intrinsics. It's not really programmable infrastructure.",
  },
  {
    kind: "code",
    group: "cdk",
    file: "infra/api.ts",
    title: "It also bothered me that the runtime code lived elsewhere",
    src: { code: CDK },
    beside: { file: "src/handler.ts", src: { code: HANDLER } },
    notes:
      "It also always bothered me that the code that actually runs in the Lambda lives somewhere else entirely: a separate file, bundled and deployed separately.",
  },
  {
    kind: "code",
    group: "cdk",
    file: "infra/api.ts",
    title: "You have to write two programs",
    src: { code: CDK },
    marks: [
      {
        kind: "underline",
        find: "class Api extends Construct",
        label: "one for the infrastructure",
        side: "right",
        tone: "construct",
      },
    ],
    beside: {
      file: "src/handler.ts",
      src: { code: HANDLER },
      marks: [
        {
          kind: "underline",
          find: "const s3 = new S3Client({});",
          label: "one for the runtime",
          side: "right",
          tone: "runtime",
        },
      ],
    },
    notes:
      "You end up writing two programs: one for the infrastructure, and one for the code that runs on it.",
  },
  {
    kind: "code",
    group: "cdk",
    file: "infra/api.ts",
    title: "…even though they're really one program",
    src: { code: CDK },
    beside: { file: "src/handler.ts", src: { code: HANDLER } },
    links: CDK_LINKS,
    frames: 45,
    notes:
      "And the two are coupled. The handler name has to match an export. The environment variable has to match what the handler reads. The grant has to cover every call the handler makes. Every change means juggling two programs that are really one.",
  },
  {
    kind: "code",
    group: "cdk",
    file: "infra/api.ts",
    title: "Rename one side, and nothing tells you the other broke",
    src: { code: CDK.replace("BUCKET_NAME", "UPLOADS_BUCKET") },
    beside: {
      file: "src/handler.ts",
      src: { code: HANDLER },
      marks: [
        { kind: "circle", find: "BUCKET_NAME", label: "undefined!", side: "right", tone: "bad" },
      ],
    },
    links: [
      { from: '"index.handler"', to: "export const handler" },
      { from: "UPLOADS_BUCKET", to: "process.env.BUCKET_NAME", tone: "bad" },
      { from: "grantReadWrite", to: "PutObjectCommand" },
    ],
    notes:
      "Rename the environment variable in the infrastructure, and the handler still compiles, still deploys, and then fails at runtime. Neither program knows about the other. That's what made me want one program, and one language, for both.",
  },
  ...program(),

  // Act 3: how we tried before
  {
    kind: "board",
    board: "history",
    stage: 0,
    title: "I've tried to build this before",
    notes: "Before Alchemy I tried this more than once.",
  },
  {
    kind: "code",
    group: "punchcard",
    file: "punchcard · stack.ts",
    title: "First came Punchcard, which added runtime code to the AWS CDK",
    src: { code: PUNCHCARD },
    tints: [{ from: "async (event", to: "}));", tone: "runtime" }],
    notes:
      "In 2018 and 2019 I built Punchcard on top of the AWS CDK. It modeled the two phases: declare a topic, depend on it from a Function, and get a typed client at runtime with the IAM policy generated for you.",
  },
  {
    kind: "code",
    group: "punchcard",
    file: "punchcard · stack.ts",
    title: "But its runtime code shipped with the whole CDK",
    src: { code: PUNCHCARD },
    tints: [{ from: "async (event", to: "}));", tone: "runtime" }],
    marks: [
      {
        kind: "circle",
        find: "SNS.Topic",
        label: "brings the CDK with it",
        side: "right",
        tone: "bad",
      },
    ],
    panel: {
      title: "What the Lambda bundle contains",
      items: [
        { title: "Your handler", bar: 0.04, tone: "runtime" },
        { title: "Punchcard", bar: 0.3, tone: "bad" },
        { title: "The AWS CDK", bar: 1, tone: "bad" },
      ],
    },
    notes:
      "The problem: it was coupled to the CDK. Importing the Topic imported everything needed to provision it, so bundling hacks had to strip the CDK out of the runtime, and serverless apps still shipped a massive amount of bloat. (Sizes illustrative.)",
  },
  {
    kind: "code",
    group: "punchcard",
    file: "punchcard · stack.ts",
    title: "And every dependency had to be declared up front",
    src: { code: PUNCHCARD },
    marks: [
      {
        kind: "circle",
        find: "depends: topic",
        label: "declared up front…",
        side: "right",
        tone: "construct",
      },
      {
        kind: "underline",
        find: "(event, topic)",
        label: "…then passed down to where it's used",
        side: "right",
        tone: "construct",
      },
    ],
    notes:
      "And every dependency had to be listed up front, in depends, and then prop-drilled into the handler as an argument. The code that uses the topic can't just reach for it.",
  },
  {
    kind: "code",
    group: "punchcard",
    file: "punchcard · stack.ts",
    title: "…and carried through every function on the way down",
    src: { code: PUNCHCARD },
    marks: [
      {
        kind: "circle",
        find: "depends: topic",
        label: "declared up front…",
        side: "right",
        tone: "construct",
      },
      {
        kind: "underline",
        find: "(event, topic)",
        label: "…then passed down to where it's used",
        side: "right",
        tone: "construct",
      },
    ],
    drill: {
      label: "in a real app",
      name: "topic",
      lines: [
        "handler(event, topic)",
        "  placeOrder(order, topic)",
        "    chargeCard(order, topic)",
        "      sendReceipt(order, topic)",
        "        topic.publish(receipt)",
      ],
      note: "carried by every layer, used by one",
    },
    frames: 45,
    notes:
      "That's prop drilling. The handler rarely publishes directly: it calls placeOrder, which calls chargeCard, which calls sendReceipt, and only that last one publishes. Every function in between has to take the topic as a parameter just to hand it down. Add a second resource and you touch every signature again.",
  },
  {
    kind: "code",
    group: "functionless",
    file: "functionless · app.ts",
    title: "Then came Functionless, which used compiler tricks instead",
    src: { code: FUNCTIONLESS },
    notes:
      "So in 2022 the next attempt, Functionless, dropped the declarations. Just use the table inside the function, and let static analysis work out what it touches.",
  },
  {
    kind: "code",
    group: "functionless",
    file: "functionless · app.ts",
    title: "It peeks inside to see which resources the function uses",
    src: { code: FUNCTIONLESS },
    marks: [
      {
        kind: "circle",
        find: "table.delete",
        label: "found by reading the body",
        side: "right",
        tone: "construct",
      },
    ],
    panel: {
      title: "Inferred",
      items: [{ title: "IAM policy", mono: `Allow dynamodb:DeleteItem\non table Todos` }],
    },
    notes:
      "It walks the function's syntax tree, follows variables into the scope they came from, sees table.delete, and infers the DynamoDB permission. That looks like it works.",
  },
  {
    kind: "code",
    group: "hidden",
    file: "functionless · app.ts",
    title: "But it can't see inside a function that's passed in",
    src: { code: deleter("Promise<void>") },
    marks: [
      {
        kind: "circle",
        find: "remove(id)",
        label: "which function? could be anything",
        side: "right",
        tone: "bad",
      },
    ],
    notes:
      "But peeking inside breaks down fast. Take a function that's passed in. Which function is remove? It depends on the caller, so reading this body tells you nothing.",
  },
  {
    kind: "code",
    group: "hidden",
    file: "functionless · app.ts",
    title: "Unless its type says what it needs",
    src: { code: deleter("Promise<void, DeleteItem>") },
    notes:
      "But what if the type of remove told us? Imagine a type parameter that lists what the function needs from the outside world: here, permission to delete an item.",
  },
  {
    kind: "code",
    group: "hidden",
    file: "functionless · app.ts",
    title: "Then inferring permissions is just type checking",
    src: { code: deleter("Promise<void, DeleteItem>") },
    marks: [
      { kind: "circle", find: "DeleteItem", tone: "construct" },
      {
        kind: "underline",
        find: "new Function",
        label: "so it needs DeleteItem too",
        side: "right",
        tone: "construct",
      },
    ],
    notes:
      "Now nobody has to read the body. A type checker never looks inside the functions you call; it reads their signatures. The Function calls remove, so it needs DeleteItem too, and that's the policy. Higher-order functions and classes just work.",
  },
  {
    kind: "code",
    group: "hidden",
    file: "functionless · app.ts",
    title: "It could say how it fails too, that seems like a good idea 😏",
    src: { code: deleter("Promise<void, NotFound, DeleteItem>") },
    notes: "And while we're at it, the type could say how the function fails, too.",
  },
  {
    kind: "code",
    group: "hidden",
    file: "functionless · app.ts",
    title: "Wait… this looks familiar",
    src: { code: deleter("Effect<void, NotFound, DeleteItem>") },
    notes: "Wait. A value, an error, and its requirements. We've seen this before.",
  },

  // Act 4: Effect is the missing piece
  {
    kind: "code",
    group: "effect",
    title: "That's exactly the type of an Effect",
    src: { code: "Effect<A, Err, Req>" },
    fontSize: 96,
    marks: [
      { kind: "underline", find: "A", label: "what it returns", side: "above", tone: "neutral" },
      { kind: "underline", find: "Err", label: "how it fails", side: "below", tone: "neutral" },
      { kind: "circle", find: "Req", label: "what it needs", side: "above", tone: "construct" },
    ],
    notes:
      "That's Effect. Success, errors, and the requirements channel: the signature we were missing.",
  },

  // Act 5: the same program, in Alchemy. The code grows one idea at a time;
  // beside it, the Worker's Req: what it still needs from the outside world.
  api({
    title: "Let's write the program again with Effect",
    snippet: "api-01-effect.ts",
    req: [],
    notes:
      "Start with just the function. Effect.gen describes a program without running it, and this one returns a fetch handler, which is itself an Effect. On the right is its Req, what it needs from the outside world. Right now: nothing.",
  }),
  api({
    title: "The outer Effect is the construction phase",
    snippet: "api-01-effect.ts",
    tints: [{ from: "const api = Effect.gen", to: "return {", tone: "construct" }],
    req: [],
    notes:
      "The outer Effect runs once, when the function is set up: that's the construction phase.",
  }),
  api({
    title: "…and fetch is the runtime phase",
    snippet: "api-01-effect.ts",
    tints: [{ from: "fetch: Effect.gen", to: "}),", tone: "runtime" }],
    req: [],
    notes:
      "And fetch runs for each request: the runtime phase. The same two phases as our imaginary language, written with plain TypeScript and Effect.",
  }),
  api({
    title: "Resources are declared in construction, with yield*",
    snippet: "api-02-bucket.ts",
    req: [],
    notes:
      "Declare a bucket in the construction phase with yield*. Creating it is the deploy's job, which we'll come back to with the Stack. For now, Req stays empty.",
  }),
  api({
    title: "My first try inferred the binding from how it's used",
    code: INFERRED,
    req: [],
    fetchReq: [GET_OBJECT],
    notes:
      "My first attempt looked exactly like the imaginary language. Just call bucket.get, and the type of that call carries the requirement: R2.GetObject for the Uploads bucket. No declaration needed.",
  }),
  api({
    title: "The goal was least privilege, guaranteed by the type checker",
    code: INFERRED,
    marks: [
      {
        kind: "underline",
        find: 'bucket.get("hello.txt")',
        label: "grant this, and nothing more",
        side: "right",
        tone: "good",
      },
    ],
    req: [],
    fetchReq: [GET_OBJECT],
    notes:
      "Here's what I was after: least privilege, guaranteed by the type checker. The type lists exactly what the code touches, and the layer you provide for each requirement grants exactly that permission. If it compiles, the function can do what it uses, and nothing more.",
  }),
  api({
    title: "Providing a layer for it grants exactly that permission",
    code: INFERRED_ON_FETCH,
    quiet: true,
    marks: [
      {
        kind: "underline",
        find: "Effect.provide(R2.ReadBucket(bucket))",
        label: "grants s3:GetObject",
        side: "right",
        tone: "good",
      },
    ],
    req: [],
    fetchReq: [met(GET_OBJECT, "R2.ReadBucket(bucket)\ngrants s3:GetObject")],
    notes:
      "And here's how it gets granted. To satisfy R2.GetObject, you provide a layer for it, R2.ReadBucket for this bucket. And providing that layer is what grants the policy: s3:GetObject on Uploads, and nothing more.",
  }),
  api({
    title: "This approach doesn't work…",
    code: INFERRED_ON_FETCH,
    quiet: true,
    cross: true,
    req: [],
    fetchReq: [met(GET_OBJECT, "R2.ReadBucket(bucket)\ngrants s3:GetObject")],
    notes:
      "It looked just like the imaginary language, and I was pretty pleased with it. But this approach doesn't work, and the problems got worse the further I took it.",
  }),
  api({
    title: "…it's in the wrong spot",
    code: INFERRED_ON_FETCH,
    marks: [
      {
        kind: "circle",
        find: "Effect.provide(R2.ReadBucket(bucket))",
        label: "on fetch, at runtime",
        side: "right",
        tone: "bad",
      },
    ],
    req: [],
    fetchReq: [
      { ...GET_OBJECT, state: "bad", note: "provided per request:\ntoo late to grant a policy" },
    ],
    notes:
      "It's in the wrong spot. The requirement lands on fetch, so that's where its layer has to be provided. But fetch runs at runtime, on every request. The layer grants the policy, and by then the deploy is long over. This makes no sense.",
  }),
  api({
    title: "Moving the bucket out lets the layer go on construction",
    code: INFERRED_HOISTED,
    req: [GET_OBJECT_HOISTED],
    notes:
      "Where we actually want it is on the outer Effect, the construction phase. So the bucket moves out to module scope, where the layer can name it, and Effect.provide(R2.ReadBucket(Uploads)) goes on the outer Effect. Now its policy is granted at deploy time, where it belongs.",
  }),
  api({
    title: "But construction only finds it by digging into fetch's type",
    code: `${INFERRED_HOISTED}\n\n${HOIST_TYPE}`,
    marks: [
      {
        kind: "circle",
        find: "infer R",
        label: "type magic on what it returns",
        side: "right",
        tone: "bad",
      },
    ],
    req: [GET_OBJECT_HOISTED],
    notes:
      "But the outer Effect doesn't need R2.GetObject. Only fetch does. The only way construction learns about it is type magic: dig into the return type of the Effect, find fetch, infer its requirements, and hoist them up. The requirement is discovered by analyzing the runtime function, not declared.",
  }),
  api({
    title: "This is starting to feel like peeking inside again…",
    code: `${INFERRED_HOISTED}\n\n${HOIST_TYPE}`,
    marks: [
      {
        kind: "circle",
        find: "infer R",
        label: "type magic on what it returns",
        side: "right",
        tone: "bad",
      },
    ],
    req: [GET_OBJECT_HOISTED],
    notes:
      "Hang on. Reaching into fetch to find out what it uses… that's Functionless all over again. Peeking inside, just with types instead of the compiler. Let's keep going anyway and see where it breaks.",
  }),
  api({
    title: "…which becomes really clear when your infrastructure is conditional",
    code: INFERRED_DEV_2,
    req: [GET_OBJECT_HOISTED, PUT_LOGS],
    notes:
      "And that becomes really clear the moment your infrastructure is conditional. Say we only want a Logs bucket in dev, and fetch writes the last read to it when it's there. That write shows up in fetch's type as R2.PutObject for Logs, and the type magic hoists it up.",
  }),
  api({
    title: "The types can't tell that logs.put only runs in dev",
    code: INFERRED_DEV_2,
    marks: [
      { kind: "underline", find: "if (logs)", label: "only in dev", side: "right", tone: "bad" },
    ],
    req: [GET_OBJECT_HOISTED, { ...PUT_LOGS, state: "bad", note: "required in every stage" }],
    notes:
      "But the if only runs in dev, and a type can't know that. fetch's type is the union of every path through it, so R2.PutObject for Logs is required everywhere, production included. Types see every possible path, never the one that actually runs.",
  }),
  api({
    title: "Now the Layer has to cover every path the code might take",
    code: INFERRED_DEV,
    req: [
      GET_OBJECT_HOISTED,
      {
        name: "R2.PutObject<Logs>",
        state: "bad",
        note: "R2.WriteBucket(Logs)\nprovided in production too",
      },
    ],
    notes:
      "So to compile, we provide R2.WriteBucket for Logs, in every stage. And the layers are what carry the policies, so every policy for every path gets granted, whether that path runs or not.",
  }),
  api({
    title: "…even the ones it never takes",
    code: INFERRED_DEV,
    marks: [
      {
        kind: "underline",
        find: "R2.WriteBucket(Logs)",
        label: "prod gets a permission only dev needs:\nleast privilege, violated",
        side: "below",
        arrow: true,
        tone: "bad",
      },
    ],
    req: [
      GET_OBJECT_HOISTED,
      {
        name: "R2.PutObject<Logs>",
        state: "bad",
        note: "R2.WriteBucket(Logs)\nprovided in production too",
      },
    ],
    notes:
      "Even if production never takes that path. The dev-only write to Logs is still in the type, so the WriteBucket layer has to be provided everywhere, and production gets permission to write to a bucket only dev uses. The very goal of this design, least privilege, is broken by the type system itself.",
  }),
  api({
    title: "Worst of all, we've broken encapsulation",
    code: INFERRED_DEV,
    marks: [
      {
        kind: "underline",
        find: "fetch: Effect.gen(function* () {",
        label: "its type now says R2, and which buckets",
        side: "right",
        tone: "bad",
      },
    ],
    req: [
      GET_OBJECT_HOISTED,
      {
        name: "R2.PutObject<Logs>",
        state: "bad",
        note: "R2.WriteBucket(Logs)\nprovided in production too",
      },
    ],
    notes:
      "Step back and look at what happened. The infrastructure a function uses has become part of its type. fetch's type now says R2, and exactly which buckets. That's broken encapsulation, and it's the problem that finally killed this design.",
  }),
  {
    kind: "code",
    group: "service",
    file: "src/Storage.ts",
    title: "To illustrate this, let's try to implement an Effect service",
    src: { code: SERVICE },
    notes:
      "To illustrate this, let's try to implement an Effect service, Effect's tool for encapsulation. An interface, with implementations provided as Layers. Storage gets a file by key, and says nothing about where files live. That's the whole point.",
  },
  {
    kind: "code",
    group: "service",
    file: "src/Storage.ts",
    title: "Its R2 implementation needs R2.GetObject<Uploads>",
    src: { code: `${SERVICE}\n\n${STORAGE_R2}` },
    marks: [
      {
        kind: "underline",
        find: "bucket.get(key)",
        label: "requires R2.GetObject<Uploads>",
        side: "right",
        tone: "bad",
      },
    ],
    notes:
      "Now implement it with R2. Because the requirement is inferred from usage, this get doesn't just return a file: its type also requires R2.GetObject for the Uploads bucket. And that doesn't match the interface, which requires nothing.",
  },
  {
    kind: "code",
    group: "service",
    file: "src/Storage.ts",
    title: "The only fix is to name R2, and the bucket, in the interface",
    src: { code: `${SERVICE_R2}\n\n${STORAGE_R2}` },
    marks: [
      {
        kind: "circle",
        find: "R2.GetObject<Uploads>",
        label: "the implementation, in the interface",
        side: "below",
        tone: "bad",
      },
    ],
    notes:
      "The only way to make it fit is to put the requirement in the interface. Now Storage says R2, and which bucket. The implementation has leaked into the interface.",
  },
  {
    kind: "code",
    group: "service",
    file: "src/Storage.ts",
    title: "Now there can never be a second implementation",
    src: { code: `${SERVICE_R2}\n\n${STORAGE_R2}\n\n${STORAGE_S3}` },
    marks: [
      {
        kind: "circle",
        find: "R2.GetObject<Uploads>",
        label: "the implementation, in the interface",
        side: "below",
        tone: "bad",
      },
      {
        kind: "underline",
        find: { text: "bucket.get(key)", nth: 2 },
        label: "requires S3.GetObject<Files>: doesn't fit",
        side: "right",
        tone: "bad",
      },
    ],
    notes:
      "And that's the nail in the coffin. Try an S3 implementation: same code, but its get requires S3.GetObject, and the interface already promised R2. You can't swap implementations, which is the whole point of a service. Infrastructure requirements can't live in the runtime function's type.",
  },
  {
    kind: "code",
    group: "service",
    file: "src/Storage.ts",
    title: "This is why a Layer yields its dependencies in the body…",
    src: { code: `${SERVICE}\n\n${STORAGE_LIVE}` },
    marks: [
      {
        kind: "underline",
        find: "const db = yield* Database;",
        label: "dependencies, yielded in the body",
        side: "right",
        tone: "construct",
      },
    ],
    notes:
      "This is why Effect has a pattern for this. When you build a Layer, you don't reach for dependencies inside each method. You yield them once, in the body of the Effect.",
  },
  {
    kind: "code",
    group: "service",
    file: "src/Storage.ts",
    title: "…and returns methods that close over them",
    src: { code: `${SERVICE}\n\n${STORAGE_LIVE}` },
    marks: [
      {
        kind: "underline",
        find: "const db = yield* Database;",
        label: "dependencies, yielded in the body",
        side: "right",
        tone: "construct",
      },
      {
        kind: "underline",
        find: "get: (key) => db.get(key),",
        label: "methods that close over them",
        side: "right",
        tone: "runtime",
      },
    ],
    notes:
      "And then it returns the implementation: methods that close over those dependencies. The interface stays clean, because the dependency lives in the constructor, not in the method's type.",
  },
  {
    kind: "code",
    group: "ctor",
    file: "src/Storage.ts",
    title: "It's an effectful constructor, like a class constructor",
    src: { code: STORAGE_LIVE },
    beside: { file: "the same idea, as a class", src: { code: STORAGE_CLASS } },
    links: [
      { from: "yield* Database", to: "constructor(private db: Database)" },
      { from: "db.get(key)", to: "this.db.get(key)", tone: "runtime" },
    ],
    frames: 40,
    notes:
      "It's called an effectful constructor, and it's just like a class constructor: take your dependencies once, up front, and the methods use them. The difference is the constructor is an Effect, so its dependencies are tracked in the type.",
  },
  api({
    title: "A cloud program is an effectful constructor too",
    snippet: "api-02-bucket.ts",
    marks: [
      {
        kind: "underline",
        find: 'const bucket = yield* R2.Bucket("Uploads");',
        label: "yields its resources",
        side: "right",
        tone: "construct",
      },
      {
        kind: "underline",
        find: "fetch: Effect.gen(function* () {",
        label: "returns what runs later",
        side: "right",
        tone: "runtime",
      },
    ],
    req: [],
    notes:
      "And that's what I finally realized. Look at our cloud program: it's the same shape. Yield resources in the body, return a fetch handler that closes over them. A cloud program is an effectful constructor, and it fits Effect's Layers perfectly. I'd been fighting the model instead of using it.",
  }),
  api({
    title: "A binding is just another dependency to yield",
    snippet: "api-04-get.ts",
    req: [{ ...READ, note: "declared in construction" }],
    notes:
      "A binding is just another dependency of the constructor. Yield R2.ReadBucket(bucket) in the body, exactly like the Storage layer yields Database, and fetch closes over the client it got back. The requirement lands on the program, where a Layer can satisfy it, and fetch's type stays clean, so a service built on it can have any implementation. It's still infrastructure as code, and I should embrace that.",
  }),
  api({
    title: "A queue works the same way",
    snippet: "api-05-queue.ts",
    req: [READ, WRITE],
    notes: "A queue is the same: declare it, ask to write to it, and Req gains Queues.WriteQueue.",
  }),
  api({
    title: "Then we hand it a Layer for each binding it needs",
    snippet: "api-06-provide.ts",
    req: [met(READ, "ReadBucketBinding"), met(WRITE, "WriteQueueBinding"), WORKER],
    notes:
      "Effect.provide satisfies each one with a Layer: an implementation of the requirement. These use Cloudflare's native bindings, and that adds a requirement of its own: they only work inside a Cloudflare Worker.",
  }),
  api({
    title: "Each one is a binding layer, and it has two faces",
    snippet: "api-06-provide.ts",
    marks: [
      {
        kind: "box",
        find: "R2.ReadBucketBinding,",
        to: "Queues.WriteQueueBinding,",
        label: "binding layers",
        side: "right",
        tone: "construct",
      },
    ],
    req: [met(READ, "ReadBucketBinding"), met(WRITE, "WriteQueueBinding"), WORKER],
    notes:
      "Each of these is a binding layer, and a binding layer has two faces: one that runs at construction, and one that runs at runtime.",
  }),
  api({
    title: "Its first face runs at construction and wires up the binding",
    snippet: "api-06-provide.ts",
    tints: [{ from: "const api = Effect.gen", to: "const jobs", tone: "construct" }],
    marks: [
      {
        kind: "circle",
        find: "R2.ReadBucket(bucket)",
        label: "binding, policy, env vars",
        side: "right",
        tone: "construct",
      },
    ],
    req: [
      met(READ, "ReadBucketBinding\nattaches the R2 binding"),
      met(WRITE, "WriteQueueBinding\nattaches the Queue binding"),
      WORKER,
    ],
    notes:
      "The first face runs during construction. When R2.ReadBucket(bucket) runs at deploy time, ReadBucketBinding wires up the binding: the native R2 binding on the Worker, plus whatever policy and environment variables it needs. Only for what the code actually declared.",
  }),
  api({
    title: "Its second face runs at runtime and implements the interface",
    snippet: "api-06-provide.ts",
    tints: [{ from: "fetch: Effect.gen", to: "}),", tone: "runtime" }],
    marks: [
      {
        kind: "underline",
        find: 'uploads.get("hello.txt")',
        label: "the layer's get",
        side: "right",
        tone: "runtime",
      },
    ],
    req: [
      met(READ, "ReadBucketBinding\nimplements get"),
      met(WRITE, "WriteQueueBinding\nimplements send"),
      WORKER,
    ],
    notes:
      "The second face is what R2.ReadBucket(bucket) returns: code that runs at runtime and implements the interface. When fetch calls uploads.get, that's the layer's get, talking to the native R2 binding.",
  }),
  api({
    title: "Conditional infrastructure is just an if statement",
    snippet: "api-06b-dev.ts",
    req: [
      met(READ, "ReadBucketBinding"),
      met(WRITE, "WriteQueueBinding"),
      met(WRITE_LOGS, "WriteBucketBinding"),
      WORKER,
    ],
    notes:
      "Remember the Logs bucket that only exists in dev? Now it's ordinary code: create it and bind it for writing only when dev is true. No new syntax, no analysis. The program uses R2.WriteBucket, so its layer, R2.WriteBucketBinding, goes in the array like any other.",
  }),
  api({
    title: 'And "peeking inside" is solved by just running the code',
    snippet: "api-06b-dev.ts",
    marks: [
      {
        kind: "underline",
        find: "R2.WriteBucket(logs)",
        label: "skipped in prod",
        side: "right",
        tone: "good",
      },
    ],
    req: [
      met(READ, "ReadBucketBinding"),
      met(WRITE, "WriteQueueBinding"),
      met(WRITE_LOGS, "WriteBucketBinding\nnever runs in prod"),
      WORKER,
    ],
    notes:
      "And that solves peeking inside. Alchemy doesn't read your code to find the bindings; it runs it. The layer's construction face only runs when that line runs. In dev it does, and the binding and its policy are attached. In production logs is undefined, so R2.WriteBucket(logs) never runs: no binding, no policy, no environment variable.",
  }),
  api({
    title: "The layer ships in the bundle, but least privilege holds",
    snippet: "api-06b-dev.ts",
    marks: [
      {
        kind: "underline",
        find: "R2.WriteBucket(logs)",
        label: "skipped in prod",
        side: "right",
        tone: "good",
      },
      {
        kind: "box",
        find: "R2.WriteBucketBinding,",
        label: "in the bundle, never granted",
        side: "right",
        tone: "good",
      },
    ],
    req: [
      met(READ, "ReadBucketBinding"),
      met(WRITE, "WriteQueueBinding"),
      met(WRITE_LOGS, "WriteBucketBinding\nno permission in prod"),
      WORKER,
    ],
    notes:
      "So the WriteBucketBinding code is still in the production bundle, but it never grants anything there. Providing a layer isn't granting a permission; running the code is. That's the difference from my first attempt, where the type demanded the permission in every stage.",
  }),
  api({
    title: "The types no longer guarantee it, running the code does",
    snippet: "api-06b-dev.ts",
    marks: [
      {
        kind: "underline",
        find: "R2.WriteBucket(logs)",
        label: "skipped in prod",
        side: "right",
        tone: "good",
      },
      {
        kind: "box",
        find: "R2.WriteBucketBinding,",
        label: "in the bundle, never granted",
        side: "right",
        tone: "good",
      },
    ],
    req: [
      met(READ, "ReadBucketBinding"),
      met(WRITE, "WriteQueueBinding"),
      met(WRITE_LOGS, "WriteBucketBinding\nno permission in prod"),
      WORKER,
    ],
    aside: { text: "pragmatism beats purity", image: "michael-pointing.jpg" },
    notes:
      "So that's where my original goal ended up. Least privilege is no longer guaranteed by the type checker; it comes from running the code. The types still guarantee every binding has an implementation, and the cost is a few bytes of unused client code in production. Pragmatism beats purity. Sorry, Michael.",
  }),
  api({
    title: "So far, though, it's just a program that nothing runs",
    snippet: "api-06-provide.ts",
    req: [met(READ, "ReadBucketBinding"), met(WRITE, "WriteQueueBinding"), WORKER],
    notes:
      "Let's drop the Logs bucket again to keep the code small. And notice what we have: api is just a value. An Effect describing a program. Nothing has deployed it, and nothing runs it yet.",
  }),
  api({
    title: "Now let's actually deploy it, starting with a Worker",
    snippet: "api-07-worker.ts",
    req: PROVIDED,
    notes:
      "So let's actually deploy it somewhere. Wrap it in a Cloudflare Worker: the function resource from our imaginary language. The Worker checks the program's Req against what it can provide, and it can provide itself.",
  }),
  api({
    title: "export default and import.meta.url say what to bundle",
    snippet: "api-07-worker.ts",
    marks: [
      {
        kind: "underline",
        find: "export default",
        label: "the Worker's entrypoint",
        side: "right",
        tone: "construct",
      },
      {
        kind: "circle",
        find: "import.meta.url",
        label: "this file",
        side: "right",
        tone: "construct",
      },
    ],
    req: PROVIDED,
    notes:
      "Two conventions you'll see everywhere. The Worker is the file's default export, and main is import.meta.url: this very file. That tells Alchemy what to bundle and what the entrypoint is. There's no separate handler file to keep in sync.",
  }),
  api({
    title: "Rolldown bundles it, and tree-shakes what you don't use",
    snippet: "api-07-worker.ts",
    marks: [
      {
        kind: "box",
        find: "R2.ReadBucketBinding,",
        to: "Queues.WriteQueueBinding,",
        label: "only these clients are bundled",
        side: "right",
        tone: "construct",
      },
    ],
    req: PROVIDED,
    bundle: PRECISE,
    notes:
      "At deploy time Alchemy runs the file through Rolldown and tree-shakes it hard. Anything the Worker doesn't reach is dropped. The binding layers you provide decide which runtime clients end up in the bundle.",
  }),
  api({
    title: "A catch-all like R2.AllBindings would bundle every client",
    code: ALL_BINDINGS,
    quiet: true,
    marks: [{ kind: "circle", find: "R2.AllBindings", tone: "bad" }],
    req: PROVIDED,
    bundle: EVERYTHING,
    frames: 50,
    notes:
      "That's why there's no R2.AllBindings or Queues.AllBindings. A catch-all would be convenient, but it would pull every client for every operation into every bundle, whether you call it or not.",
  }),
  api({
    title: "That's why you provide only the bindings you use",
    snippet: "api-07-worker.ts",
    quiet: true,
    marks: [
      {
        kind: "box",
        find: "R2.ReadBucketBinding,",
        to: "Queues.WriteQueueBinding,",
        label: "just what you use",
        side: "right",
        tone: "good",
      },
    ],
    req: PROVIDED,
    bundle: PRECISE,
    notes:
      "So you provide the specific bindings, one per capability. It's a little more typing, and it keeps each bundle down to exactly the code it runs.",
  }),
  api({
    title: "The right bindings also depend on where it runs",
    snippet: "api-10-lambda.error.ts",
    error: { hide: true },
    req: [...PROVIDED.slice(0, 2), WORKER],
    notes:
      "Which bindings are right also depends on where the program runs. The program itself doesn't care, so let's swap Cloudflare.Worker for AWS.Lambda.Function.",
  }),
  api({
    title: "On Lambda, our Cloudflare binding layers won't compile",
    snippet: "api-10-lambda.error.ts",
    error: { pick: firstLine("Type 'WorkerEnvironment'") },
    req: [...PROVIDED.slice(0, 2), { ...WORKER, state: "bad", note: "not a Worker" }],
    notes:
      "The native binding layers require a Cloudflare Worker, and a Lambda Function can't provide one. The type checker catches it before anything is deployed.",
  }),
  api({
    title: "Swap the native bindings for HTTP, and it runs anywhere",
    snippet: "api-11-http.error.ts",
    // TODO: fails today: Cloudflare *Http layers also need CloudflareEnvironment and Self,
    // which AWS.Lambda.Function doesn't provide yet.
    error: { hide: true },
    req: [
      met(READ, "ReadBucketHttp\ncalls Cloudflare's API"),
      met(WRITE, "WriteQueueHttp\ncalls Cloudflare's API"),
    ],
    notes:
      "Swap each binding layer for its HTTP twin. ReadBucketHttp and WriteQueueHttp call Cloudflare's API instead of a native binding, so they don't need a Worker, and the Cloudflare.Worker requirement disappears. Same program, different runtime, different layer. That's the other reason there's no AllBindings: the right implementation depends on the environment you're running in, so you choose it.",
  }),
  api({
    title: "Each HTTP layer mints a least-privilege Cloudflare API token",
    snippet: "api-11-http.error.ts",
    error: { hide: true },
    marks: [
      {
        kind: "box",
        find: "R2.ReadBucketHttp,",
        to: "Queues.WriteQueueHttp,",
        label: "one scoped token each",
        side: "right",
        tone: "construct",
      },
    ],
    req: [
      met(READ, "ReadBucketHttp\nmints an R2 read-only API token"),
      met(WRITE, "WriteQueueHttp\nmints a Queues write-only API token"),
    ],
    notes:
      "But how does a Lambda get into Cloudflare? At deploy time, each HTTP layer's construction face mints a Cloudflare account API token, scoped to exactly what the code declared: read this bucket, write to this queue, and nothing else.",
  }),
  {
    kind: "code",
    group: "api",
    file: "src/Api.ts",
    title: "…and binds it securely into the Lambda",
    src: { snippet: "api-11-http.error.ts", regions: ["show"] },
    error: { hide: true },
    diagram: CROSS_CLOUD(false),
    notes:
      "Then it binds the token into the Lambda as a secret, just like the bucket's name was bound in our imaginary language. The token never appears in your code or your repository.",
  },
  {
    kind: "code",
    group: "api",
    file: "src/Api.ts",
    title: "Now AWS can call Cloudflare, with only the access it needs",
    src: { snippet: "api-11-http.error.ts", regions: ["show"] },
    error: { hide: true },
    diagram: CROSS_CLOUD(true),
    notes:
      "And now the Lambda, running in AWS, reads from R2 and writes to a Cloudflare Queue, with a token that can do exactly that. Cross-cloud, least privilege, and the same program as before.",
  },
  lang({
    group: "phase-callback",
    title: "Remember the phase rule from our imaginary language?",
    src: { code: COLORED_BAD },
    marks: [
      {
        kind: "strike",
        find: "Bucket()",
        label: "can't create a resource at runtime",
        side: "right",
        tone: "bad",
      },
    ],
    notes:
      "Before we deploy, remember the rule from our imaginary language. Construction and runtime are different colors, and creating a bucket inside a request was a compile error.",
  }),
  lang({
    group: "phase-callback",
    title: "…and that construction can't call runtime code",
    src: { code: COLORED_EARLY },
    quiet: true,
    marks: [
      {
        kind: "strike",
        find: 'bucket.get("hello.txt")',
        label: "no request yet",
        side: "right",
        tone: "bad",
      },
    ],
    notes:
      "And the other direction: reading the bucket during construction, when there's no request yet, was an error too.",
  }),
  api({
    title: "So let's make that mistake in Alchemy",
    snippet: "api-08-construct.error.ts",
    marks: [
      {
        kind: "underline",
        find: 'yield* uploads.get("hello.txt");',
        label: "at deploy time",
        side: "right",
        tone: "bad",
      },
    ],
    error: { hide: true },
    req: [...PROVIDED, { name: "RuntimeContext", note: "only exists during a request" }],
    notes:
      "Let's make exactly that mistake in the Worker: read the bucket during construction, at deploy time, when there's no request yet. Req picks up RuntimeContext.",
  }),
  api({
    title: "It won't compile, because a Worker can't provide RuntimeContext",
    snippet: "api-08-construct.error.ts",
    error: { pick: firstLine("Type 'RuntimeContext'") },
    req: [
      ...PROVIDED,
      { name: "RuntimeContext", state: "bad", note: "only exists during a request" },
    ],
    notes:
      "A Worker's constructor runs at deploy time and cold start, with no request, so it can't provide RuntimeContext. Reading the bucket there is a type error, just like in our imaginary language.",
  }),
  api({
    title: "Unless you opt out explicitly (don't do this)",
    snippet: "api-09-phantom.ts",
    req: [...PROVIDED, PHANTOM],
    notes:
      "You can still make the call, but only by providing RuntimeContext.phantom: an explicit opt-out that squashes the error, like ts-expect-error. It's there for emergencies. Don't do this.",
  }),
  api({
    title: "What actually creates the bucket, though?",
    snippet: "api-07-worker.ts",
    marks: [{ kind: "circle", find: 'R2.Bucket("Uploads")', tone: "construct" }],
    req: PROVIDED,
    notes:
      "Drop the opt-out, we're done with that. We've seen exactly what ends up in the Worker's bundle. But nothing in it creates the bucket. So what does declaring one actually do?",
  }),
  api({
    title: "Declaring a resource just yields a plain piece of data",
    snippet: "api-07-worker.ts",
    marks: [
      {
        kind: "circle",
        find: 'R2.Bucket("Uploads")',
        label: "a type, a name, and props",
        side: "right",
        tone: "construct",
      },
    ],
    req: PROVIDED,
    notes:
      "A resource in Alchemy is just data: its type, its name, and its props. Yielding it doesn't call any cloud API.",
  }),
  api({
    title: "…that asks for a provider to create it",
    snippet: "api-07-worker.ts",
    marks: [
      {
        kind: "underline",
        find: 'R2.Bucket("Uploads")',
        label: "needs R2.BucketProvider",
        side: "right",
        tone: "construct",
      },
      {
        kind: "underline",
        find: 'Queues.Queue("Jobs")',
        label: "needs Queues.QueueProvider",
        side: "right",
        tone: "construct",
      },
    ],
    req: [BUCKET, ...PROVIDED.slice(0, 1), QUEUE, ...PROVIDED.slice(1)],
    notes:
      "And it expresses a requirement: a provider that knows how to create, update and delete that kind of resource. R2.BucketProvider, Queues.QueueProvider. They show up in Req like any other requirement.",
  }),
  api({
    title: "Unlike a CDK construct, none of the provisioning code is in here",
    snippet: "api-07-worker.ts",
    marks: [
      {
        kind: "box",
        find: 'const bucket = yield* R2.Bucket("Uploads");',
        to: "const jobs = yield* Queues.WriteQueue(queue);",
        label: "no create, update, or delete",
        side: "right",
        tone: "good",
      },
    ],
    req: [BUCKET, ...PROVIDED.slice(0, 1), QUEUE, ...PROVIDED.slice(1)],
    notes:
      "Compare that with where I started. A CDK construct carries all of its provisioning code with it. Here the resource is a description plus a requirement, and the code that actually provisions it lives somewhere else.",
  }),
  stack({
    title: "This is where Stacks come in",
    code: STACK_1,
    notes:
      "So who provides the providers, and how do we actually deploy this Worker? This is where Stacks come in: the entry point for alchemy deploy, in alchemy.run.ts. It starts with a name.",
  }),
  stack({
    title: "A Stack is a set of resources you deploy as one unit",
    code: STACK_1,
    marks: [{ kind: "circle", find: '"App"', label: "one app", side: "right", tone: "construct" }],
    notes:
      "So what is a Stack? It's the root of the program: a collection of resources that are deployed, updated and destroyed together, as one unit.",
  }),
  stack({
    title: "…and each stage is its own isolated copy of it",
    code: STACK_1,
    marks: [{ kind: "circle", find: '"App"', label: "one app", side: "right", tone: "construct" }],
    diagram: STAGES,
    notes:
      "And every deploy targets a stage. Each stage is a separate, isolated instance of the same Stack, with its own resources and its own state. Your dev copy and production never share a resource.",
  }),
  stack({
    title: "We give the Stack the providers that create resources",
    code: STACK_2,
    notes:
      "Next, the providers: the code that actually creates, updates and deletes resources. Cloudflare.providers() is every Cloudflare provider there is.",
  }),
  stack({
    title: "All of them, because this code isn't bundled or used at runtime",
    code: STACK_2,
    marks: [
      {
        kind: "box",
        find: "providers: Cloudflare.providers(),",
        label: "all of them",
        side: "right",
        tone: "construct",
      },
    ],
    notes:
      "Unlike the bindings, we don't have to be precise here. This code is never bundled into the Worker and never runs at runtime. It only runs on your machine, or in CI, during deploy, so none of it needs to be tree-shaken.",
  }),
  stack({
    title: "It also needs somewhere to remember what it deployed",
    code: STACK_3,
    notes:
      "Then state: where Alchemy records what it deployed for each stage, so the next deploy knows what to create, update or delete. Here it's stored in your Cloudflare account, so your laptop and CI share it.",
  }),
  stack({
    title: "Then you give it an Effect that yields the resources you want",
    code: STACK_4,
    notes:
      "Finally, the program itself: an Effect that yields the resources you want. Here, that's our Worker.",
  }),
  {
    kind: "code",
    group: "stack",
    file: "alchemy.run.ts",
    title: "…and returns what we want to know, like its URL",
    src: { snippet: "stack.ts", regions: ["show"] },
    notes:
      "And it returns the outputs we care about, like the Worker's URL, printed after every deploy.",
  },
  {
    kind: "code",
    group: "stack",
    file: "alchemy.run.ts",
    title: "Yielding Api brings its provider requirements with it",
    src: { snippet: "stack.ts", regions: ["show"] },
    marks: [
      {
        kind: "underline",
        find: "yield* Api",
        label: "needs these",
        side: "right",
        tone: "construct",
      },
    ],
    req: { label: REQ_LABEL, items: [BUCKET, WORKER_PROVIDER, QUEUE] },
    notes:
      "Yielding Api brings its requirements along: a provider for every kind of resource it declared. R2.BucketProvider for the bucket, Queues.QueueProvider for the queue, and Cloudflare.WorkerProvider for the Worker itself. They bubble up to the Stack.",
  },
  {
    kind: "code",
    group: "stack",
    file: "alchemy.run.ts",
    title: "…and Cloudflare.providers() satisfies all of them",
    src: { snippet: "stack.ts", regions: ["show"] },
    marks: [
      {
        kind: "box",
        find: "providers: Cloudflare.providers(),",
        label: "all three",
        side: "right",
        tone: "good",
      },
    ],
    req: { label: REQ_LABEL, items: [met(BUCKET, ""), met(WORKER_PROVIDER, ""), met(QUEUE, "")] },
    notes:
      "And the providers we gave the Stack satisfy them. That's why it can be every Cloudflare provider: this code runs during deploy, and none of it ships in the Worker.",
  },
  {
    kind: "code",
    group: "stack",
    file: "alchemy.run.ts",
    title: "Give it no providers, and it won't compile",
    src: { snippet: "stack-empty.error.ts", regions: ["show"] },
    quiet: true,
    error: { pick: (lines) => lines.slice(0, 2) },
    req: {
      label: REQ_LABEL,
      items: [
        { ...BUCKET, state: "bad", note: "" },
        { ...WORKER_PROVIDER, state: "bad", note: "" },
        { ...QUEUE, state: "bad", note: "" },
      ],
    },
    notes:
      "And it's checked. Swap Cloudflare.providers() for Layer.empty and the Stack no longer compiles: the Worker still needs its providers, and nothing is providing them.",
  },

  {
    kind: "code",
    group: "deploy",
    file: "terminal",
    lang: "ansi",
    title: "alchemy deploy runs the Stack and shows you a plan",
    src: { code: DEPLOY_PLAN },
    marks: [
      {
        kind: "box",
        find: "+ Api (Cloudflare.Worker)",
        to: "  + Jobs",
        label: "the bindings, too",
        side: "right",
        tone: "construct",
      },
    ],
    notes:
      "Now deploy. alchemy deploy runs the Stack's construction phase on your machine. That run discovers every resource and binding, and diffs them against the state into a plan: three resources to create, and the Worker's two bindings.",
  },
  {
    kind: "code",
    group: "deploy",
    file: "terminal",
    lang: "ansi",
    title: "Approve it, and everything is created and wired together",
    src: { code: DEPLOY_APPLIED },
    notes:
      "Approve it, and the providers do the work: the bucket, the queue, then the Worker with its bindings attached. One program, deployed. Now let's build something real.",
  },
  ...demo,
];

// ─── The talk: condensed ─────────────────────────────────────────────────────
// The problem fast, the idea (a language for the cloud) as a hypothetical, why
// Alchemy is shaped the way it is, then demos. Steps are picked from `allSteps`
// by title, optionally retitled, with a few new ones in between.

/** A step from `allSteps`, by its current title; `as` renames it for the new flow. */
const pick = (title: string, as?: string, patch?: Partial<CodeSpec>): StepSpec => {
  const found = allSteps.find((step) => step.title === title);
  if (!found) throw new Error(`no step titled ${JSON.stringify(title)}`);
  return { ...found, ...(as ? { title: as } : {}), ...(patch ?? {}) } as StepSpec;
};

const LIVE = {
  file: "src/Api.ts",
  snippet: "ApiLive.ts",
  group: "demo-live",
  regions: ["top", "rooms", "fetchTop", "live", "click", "fetchEnd"],
};
const ROOM = { file: "src/LinkRoom.ts", snippet: "LinkRoom.ts", group: "demo-room" };

/** A code step from the Shorty app in `snippets/shorty/`. */
const shorty = (s: {
  title: string;
  notes: string;
  file: string;
  snippet: string;
  group: string;
  regions?: string[];
  omit?: string[];
  marks?: CodeSpec["marks"];
}): StepSpec => ({
  kind: "code",
  group: s.group,
  file: s.file,
  title: s.title,
  src: { snippet: `shorty/${s.snippet}`, regions: s.regions ?? ["show"], omit: s.omit },
  marks: s.marks,
  notes: s.notes,
});

const liveClicks: StepSpec[] = [
  {
    kind: "slide",
    layout: "section",
    title: "Now let's make it live",
    eyebrow: "Durable Objects + WebSockets",
    heading: "Now let's make it live",
    subtitle: "Every click, pushed to every dashboard, as it happens",
    notes:
      "Shorty works. Now let's make it feel alive: count every click, and push the count to every open dashboard in real time. That's a job for a Durable Object with WebSockets.",
  },
  shorty({
    ...ROOM,
    title: "A Durable Object is a tiny stateful server per link",
    omit: ["count", "record", "socket"],
    notes:
      "A Durable Object is a class with its own storage, one instance per name. We'll have one per short link: a room that owns that link's clicks.",
  }),
  shorty({
    ...ROOM,
    title: "It keeps the click count in its own storage",
    omit: ["record", "socket"],
    notes: "When it wakes up, it reads its count from transactional storage.",
  }),
  shorty({
    ...ROOM,
    title: "Each click bumps the count and saves it",
    regions: ["body"],
    omit: ["push", "socket"],
    notes:
      "record adds one and saves it. Storage and compute live together, so there's no round trip to a database.",
  }),
  shorty({
    ...ROOM,
    title: "fetch upgrades to a WebSocket",
    regions: ["body"],
    omit: ["push"],
    notes: "fetch upgrades the request to a WebSocket and sends the current count straight away.",
  }),
  shorty({
    ...ROOM,
    title: "…and every click is pushed to every socket",
    regions: ["body"],
    notes:
      "And on every click, the new count goes to every connected socket. These are hibernatable: the object can sleep while the sockets stay open, so idle rooms cost nothing.",
  }),
  shorty({
    ...LIVE,
    title: "The Worker asks for the rooms, like any other binding",
    omit: ["live", "click"],
    notes:
      "In the Worker, yield LinkRoom. Same shape as every binding so far: declared in construction, used at runtime.",
  }),
  shorty({
    ...LIVE,
    title: "A click records itself in the link's room…",
    omit: ["live"],
    notes:
      "When someone follows a short link, look it up, record the click in that link's room, and redirect.",
  }),
  shorty({
    ...LIVE,
    title: "…and /live hands the socket to the room",
    notes:
      "And GET /:code/live hands the WebSocket straight to the room. That's the whole backend.",
  }),
  shorty({
    title: "The dashboard just opens a socket",
    notes:
      "On the website, each row opens a socket to its link's room and renders whatever arrives.",
    file: "web/src/useClicks.ts",
    snippet: "useClicks.ts",
    group: "demo-hook",
  }),
  {
    kind: "browser",
    title: "Click a link, and every dashboard updates",
    url: "http://localhost:5173",
    image: "04-durable-objects-browser-1.png",
    notes:
      "Click the link from your phone and the count ticks up here, instantly. No polling, no pub/sub service to set up.",
  },
];

export const steps: StepSpec[] = [
  pick("A programming language for the cloud"),

  // 1. The problem, fast
  pick(
    "Infrastructure as code declares what should be, not what is",
    "Infrastructure as code: declare what the cloud should be",
  ),
  pick("An engine compares it to the cloud, and creates what's missing"),
  pick("Then the AWS CDK came out", "The CDK made it real code"),
  pick(
    "It also bothered me that the runtime code lived elsewhere",
    "But the code that runs is a second program",
  ),
  pick("Rename one side, and nothing tells you the other broke"),

  // 2. The idea: a language for the cloud
  pick(
    "I wanted one language where a variable could be a cloud resource",
    "Imagine a language where a variable is a cloud resource",
  ),
  pick("You'd declare a queue the same way"),
  pick("Functions would be resources too"),
  pick("When the function reads the bucket, they'd become connected"),
  pick("That connection would need permission to read the bucket"),
  pick("Sending to the queue would connect them the same way"),
  pick(
    "The language would work all of this out from code",
    "Least-privilege IAM, inferred from the code",
  ),
  pick("But what if the function created a bucket?"),
  pick("Uh-oh. Resources need to be known ahead of time"),
  pick("…and code outside the function has no request to serve"),
  pick("So a cloud program is actually a language with two phases"),
  pick("Now creating a bucket at runtime is a compile error"),
  pick("And inferring permissions becomes a kind of type checking"),

  // 3. Effect already models this
  ...typedFetch,
  pick("That's exactly the type of an Effect"),

  // 4. How bindings work in Alchemy
  pick("Let's write the program again with Effect", "So let's write it with Effect"),
  pick("Resources are declared in construction, with yield*"),
  api({
    title: "Translated directly, the need lands on fetch",
    code: INFERRED,
    emphasize: ["bucket.get("],
    req: [],
    fetchReq: [{ name: "R2.GetObject<Uploads>", note: "to read the bucket" }],
    notes:
      "Translate the imaginary language directly: fetch calls bucket.get, and its type needs R2.GetObject for Uploads. So the requirement lands on fetch.",
  }),
  api({
    title: "But permissions are granted at deploy, and deploy runs construction",
    code: INFERRED,
    marks: [
      {
        kind: "underline",
        find: "fetch: Effect.gen(function* () {",
        label: "runs per request, too late to grant anything",
        side: "right",
        tone: "bad",
      },
    ],
    req: [],
    fetchReq: [{ name: "R2.GetObject<Uploads>", state: "bad", note: "to read the bucket" }],
    notes:
      "But whatever grants s3:GetObject has to run when the Worker is deployed, and that's construction. fetch only runs once requests arrive, long after the deploy.",
  }),
  pick(
    "A binding is just another dependency to yield",
    "So declare it in construction, and get back a client",
  ),
  pick("A queue works the same way"),
  pick("Then we hand it a Layer for each binding it needs"),
  pick("Each one is a binding layer, and it has two faces"),
  pick("Its first face runs at construction and wires up the binding"),
  pick("Its second face runs at runtime and implements the interface"),
  pick("Conditional infrastructure is just an if statement"),
  pick(
    'And "peeking inside" is solved by just running the code',
    "Running the code decides what's granted",
  ),
  pick(
    "Now let's actually deploy it, starting with a Worker",
    "Wrap it in a Worker, and it deploys",
    { group: "api-host" },
  ),
  pick(
    "On Lambda, our Cloudflare binding layers won't compile",
    "Point it at Lambda, and the types catch the wrong bindings",
    { group: "api-host" },
  ),
  pick("Swap the native bindings for HTTP, and it runs anywhere", undefined, { group: "api-host" }),
  pick("Now AWS can call Cloudflare, with only the access it needs", undefined, {
    group: "api-host",
  }),
  pick("This is where Stacks come in", "A Stack deploys it"),
  pick("Yielding Api brings its provider requirements with it"),
  pick("…and Cloudflare.providers() satisfies all of them"),
  pick("alchemy deploy runs the Stack and shows you a plan"),
  pick("Approve it, and everything is created and wired together"),

  // 5. Demo: build Shorty with an agent
  ...allSteps.slice(allSteps.findIndex((s) => s.title === "Let's build something")),

  // 6. Demo: live clicks with Durable Objects and WebSockets
  ...liveClicks,
];
