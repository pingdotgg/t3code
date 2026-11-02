/**
 * Steps: `link` opens `t3code://<path>`, where `{thread:<id>}` becomes `<environmentId>/<threadId>`
 * for a seeded or live fixture thread; `tap` presses the first element whose accessibility label
 * matches the regex; `focus: "composer"` taps the unlabelled composer.
 */

export const AXES = [
  {
    id: "visual",
    label: "Visual design",
    description: "type, color, icons, spacing and hierarchy",
  },
  {
    id: "layout",
    label: "Layout quality",
    description: "use of the screen, safe areas, the keyboard, folds and rotation, large text",
  },
  {
    id: "flow",
    label: "Flow clarity",
    description: "how obvious each task is, from the flows and from what each screen offers next",
  },
  {
    id: "polish",
    label: "Polish",
    description:
      "alignment, truncation, clipped or overlapping content, empty space, state indicators",
  },
  {
    id: "desktop",
    label: "Conformance with desktop",
    description: "whether this reads as the same product as the desktop app",
  },
  {
    id: "competitors",
    label: "Quality versus Codex and Claude",
    description: "how this compares with the Codex and Claude iOS apps",
  },
] as const;
export type AxisId = (typeof AXES)[number]["id"];

export const DEVICE_CLASSES = [
  { id: "iphone", label: "iPhone 17 Pro" },
  { id: "duo", label: "iPhone Duo (closed and open)" },
  { id: "ipad", label: "iPad Pro 13" },
] as const;
export type DeviceClassId = (typeof DEVICE_CLASSES)[number]["id"];

/** One simulator per device class; poses change its settings while the app runs. */
export const SIMULATORS = {
  iphone: { name: "T3 Design iPhone 17 Pro", type: "iPhone-17-Pro" },
  duo: { name: "T3 Design iPhone Duo", type: "iPhone-Duo" },
  ipad: { name: "T3 Design iPad Pro 13", type: "iPad-Pro-13-inch-M5-16GB" },
} as const satisfies Record<DeviceClassId, { readonly name: string; readonly type: string }>;

export type StepAction =
  | { readonly link: string }
  | {
      /** One pattern, or several in order of preference; the first one on screen is tapped. */
      readonly tap: string | ReadonlyArray<string>;
      /** Skip the step when nothing matches within a few seconds. */
      readonly optional?: true;
      /** Skip the step when this label already shows. */
      readonly skipIf?: string;
    }
  | { readonly type: string }
  | { readonly scroll: "up" | "down" }
  | { readonly focus: "composer" }
  | { readonly clear: "composer" };

export interface Pose {
  readonly id: string;
  readonly device: DeviceClassId;
  readonly label: string;
  readonly appearance: "dark" | "light";
  readonly orientation?: "portrait" | "landscape";
  readonly fold?: "closed" | "open";
  readonly textSize?: string;
  /** Scenes this pose captures; all scenes when omitted. */
  readonly scenes?: ReadonlyArray<SceneId>;
  /** Why this pose exists, when it guards a known complaint. */
  readonly source?: string;
}

export interface Scene {
  readonly id: string;
  readonly title: string;
  /** Where the scene came from: the issue it guards, or the request that asked for it. */
  readonly source: string;
  readonly steps: ReadonlyArray<StepAction>;
  /** Wait for this label before the screenshot. */
  readonly ready?: string;
  /** Relaunch first: on iPad, a thread an earlier scene opened would fill the detail column. */
  readonly fresh?: true;
  /** Desktop web path for the "conforms to desktop" pair, relative to the environment origin. */
  readonly desktop?: { readonly path: string; readonly click?: string };
  /** Runs after the screenshot, to undo state later scenes would see, such as a typed draft. */
  readonly reset?: ReadonlyArray<StepAction>;
}

const REQUEST = "Mobile design eval request";
const thread = (id: string) => ({ link: `threads/{thread:${id}}` });

export const SCENES = [
  {
    id: "threads",
    title: "Thread list",
    source: `${REQUEST}; #22543 (iPad sidebar hides the newest thread)`,
    steps: [],
    fresh: true,
    ready: "^Plan offline mode",
    desktop: { path: "/" },
  },
  {
    id: "thread-settled",
    title: "Thread, settled",
    source: REQUEST,
    steps: [thread("remote-command-center")],
    ready: "^Copy message$",
    desktop: { path: "/{thread:remote-command-center}" },
  },
  {
    id: "thread-tool-calls",
    title: "Thread with tool calls and file changes, expanded",
    source: `${REQUEST}; #24930 (conversation text under the header)`,
    steps: [thread("tool-calls"), { tap: "^Worked for" }, { tap: "^Ran \\d+ commands" }],
    ready: "^Copy message$",
    desktop: { path: "/{thread:tool-calls}", click: "text=/^Worked for/" },
  },
  {
    id: "thread-long-code",
    title: "Thread with a long code block",
    source: `${REQUEST}; #24930 (conversation text under the header)`,
    steps: [thread("long-code"), { scroll: "up" }],
    desktop: { path: "/{thread:long-code}" },
  },
  {
    id: "thread-streaming",
    title: "Thread while the agent streams",
    source: REQUEST,
    steps: [thread("streaming")],
    ready: "^Stop agent$",
    desktop: { path: "/{thread:streaming}" },
  },
  {
    id: "composer-focused",
    title: "Composer, empty and focused",
    source: REQUEST,
    steps: [thread("remote-command-center"), { focus: "composer" }],
  },
  {
    id: "composer-long-prompt",
    title: "Composer with a long prompt",
    source: REQUEST,
    steps: [thread("pocket-command-center")],
  },
  {
    id: "composer-attachments",
    title: "Composer with image attachments",
    source: REQUEST,
    steps: [thread("handoff-haptics")],
  },
  {
    id: "composer-model-picker",
    title: "Model picker open",
    source: REQUEST,
    steps: [thread("tool-calls"), { tap: "^Model and reasoning settings" }],
    ready: "^Thread settings$",
    desktop: { path: "/{thread:tool-calls}", click: "role=button[name=/GPT-5.4/]" },
  },
  {
    id: "composer-slash",
    title: "Slash suggestions while the agent runs",
    source: `${REQUEST}; #16112 (running pill over slash suggestions)`,
    steps: [thread("streaming"), { focus: "composer" }, { type: "/" }],
    reset: [{ clear: "composer" }],
  },
  {
    id: "new-thread",
    title: "New thread, project chosen",
    source: REQUEST,
    steps: [{ link: "new" }, { tap: "^T3 Code$", skipIf: "^Project: " }],
    // The web app has no new-thread route; its home page is the new-thread screen.
    desktop: { path: "/" },
  },
  {
    id: "question",
    title: "Agent asks two questions",
    source: `${REQUEST}; #24290 and #24291 (Duo question panel)`,
    steps: [thread("question")],
    ready: "^(Submit answers|Next question)$",
    desktop: { path: "/{thread:question}" },
  },
  {
    id: "approval",
    title: "Agent asks to run a command",
    source: REQUEST,
    steps: [thread("approval")],
    ready: "^Allow once$",
    desktop: { path: "/{thread:approval}" },
  },
  {
    id: "background",
    title: "Background work after the turn",
    source: REQUEST,
    steps: [thread("background")],
    ready: "^Stop background work$",
    desktop: { path: "/{thread:background}" },
  },
  {
    id: "background-sheet",
    title: "Background work details",
    source: REQUEST,
    steps: [thread("background"), { tap: "^Running: " }],
  },
  {
    id: "terminal",
    title: "Terminal",
    source: REQUEST,
    steps: [{ link: "threads/{thread:remote-command-center}/terminal?terminalId=term-1" }],
  },
  {
    id: "review",
    title: "Review and diff",
    source: REQUEST,
    steps: [{ link: "threads/{thread:remote-command-center}/review" }],
    // Older builds title it "Changes vs main"; newer ones put "vs main" on a second line.
    ready: "^(Changes )?vs main",
  },
  {
    id: "settings",
    title: "Settings",
    source: REQUEST,
    steps: [{ link: "settings" }],
    desktop: { path: "/settings/general" },
  },
  {
    id: "environments",
    title: "Environments",
    source: REQUEST,
    steps: [{ link: "settings/environments" }],
    desktop: { path: "/settings/connections" },
  },
] as const satisfies ReadonlyArray<Scene>;
export type SceneId = (typeof SCENES)[number]["id"];

export const POSES = [
  { id: "iphone-dark", device: "iphone", label: "iPhone, dark", appearance: "dark" },
  { id: "iphone-light", device: "iphone", label: "iPhone, light", appearance: "light" },
  {
    id: "iphone-large-text",
    device: "iphone",
    label: "iPhone, largest accessibility text",
    appearance: "dark",
    textSize: "accessibility-extra-extra-extra-large",
    scenes: ["threads", "thread-tool-calls", "question", "composer-model-picker", "settings"],
    source: "#17912 (Dynamic Type)",
  },
  {
    id: "iphone-landscape",
    device: "iphone",
    label: "iPhone held in landscape",
    appearance: "dark",
    orientation: "landscape",
    scenes: ["threads", "thread-tool-calls"],
    source: "#19709 and #16511 (landscape iPhone)",
  },
  ...(["closed", "open"] as const).flatMap((fold) =>
    (["dark", "light"] as const).map((appearance): Pose => ({
      id: `duo-${fold}-${appearance}`,
      device: "duo",
      label: `iPhone Duo ${fold}, ${appearance}`,
      appearance,
      fold,
    })),
  ),
  ...(["landscape", "portrait"] as const).flatMap((orientation) =>
    (["dark", "light"] as const).map((appearance): Pose => ({
      id: `ipad-${orientation}-${appearance}`,
      device: "ipad",
      label: `iPad ${orientation}, ${appearance}`,
      appearance,
      orientation,
    })),
  ),
] as const satisfies ReadonlyArray<Pose>;

export interface Flow {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  /** Each step is one screenshot; `tap` and `focus` steps count as taps. */
  readonly steps: ReadonlyArray<StepAction>;
}

/** Common tasks, walked from the thread list on the dark iPhone pose, after every scene. */
export const FLOWS = [
  {
    id: "start-thread",
    title: "Start a thread in a chosen project and machine",
    source: REQUEST,
    steps: [
      { tap: "^(New chat|New thread)$" },
      // New thread can open straight onto the project picker, or a draft with one project chip.
      { tap: ["^Project: ", "^T3 Code$"], skipIf: "^Choose project$" },
      { tap: "^React(,|$)" },
      // A build whose project chip also names the machine has no separate machine step.
      { tap: "^Choose environment", skipIf: "^Project: " },
      // Pick whichever machine the picker offers; when it is not the project's, the frames show it.
      { tap: "^(Suspense Station|Moonbase Terminal|Kernel Cabin)", skipIf: "^Project: " },
      { focus: "composer" },
      { type: "Add a loading skeleton to the profile page" },
      { tap: "^Send$" },
    ],
  },
  {
    id: "answer-question",
    title: "Answer the agent's questions",
    source: REQUEST,
    steps: [
      { tap: "^Plan offline mode$" },
      { tap: "^Last 50 threads" },
      { tap: "^Next question$", optional: true },
      { tap: "^Server state" },
      { tap: "^Submit answers$" },
    ],
  },
  {
    id: "review-diff",
    title: "Review a thread's diff",
    source: REQUEST,
    steps: [
      { tap: "^Make remote coding feel local" },
      // A crowded header folds its buttons into a More menu.
      { tap: ["^(Changes )?[+]\\d+ [-−]\\d+", "^(Git|Panel|Toggle panel)$", "^More$"] },
      {
        tap: ["^(Changes )?[+]\\d+ [-−]\\d+", "^(Review changes|Diff$)", "^(Panel|Toggle panel)$"],
        skipIf: "^(Select diff|Open full review)$",
      },
      { tap: "^Diff$", optional: true, skipIf: "^(Select diff|Open full review)$" },
    ],
  },
  {
    id: "stop-background",
    title: "Stop background work",
    source: REQUEST,
    steps: [{ tap: "^Check settings in the dev server$" }, { tap: "^Stop background work$" }],
  },
  {
    id: "find-old-thread",
    title: "Find an old thread",
    source: REQUEST,
    steps: [{ tap: "^(Search|Search threads)$" }, { type: "OOM" }, { tap: "OOM killer" }],
  },
  {
    id: "change-model",
    title: "Change the model",
    source: REQUEST,
    steps: [
      { tap: "^Show a reconnect banner$" },
      { tap: "^Model and reasoning settings" },
      { tap: "^GPT-5.3 Codex" },
      { tap: "^Save thread settings$", optional: true },
    ],
  },
] as const satisfies ReadonlyArray<Flow>;

/** The default council. `--panel` adds `muse` for copy-heavy rounds. */
export const PANEL = {
  opus: {
    label: "Claude Opus 5.5",
    provider: "claudeAgent",
    model: "claude-opus-5-5",
    effort: "xhigh",
  },
  sol: { label: "Codex GPT-6.1 Sol", provider: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
  muse: {
    label: "Muse Wonder Full",
    provider: "muse",
    model: "muse-proxy-wonder-full",
    effort: "xhigh",
  },
} as const;
export type PanelMember = keyof typeof PANEL;
export const DEFAULT_PANEL: ReadonlyArray<PanelMember> = ["opus", "sol"];
