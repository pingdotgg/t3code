// Mobile 2.4 staging: "devbox" with mugshot, a localhost:5199 page, a writable mock Linear and
// scripted Claude turns (studio redesign; MUG-142 fix with subagent and /btw side chat).
// Usage: serve.mjs <out-dir> [--reuse]  (--reuse keeps the home and port, so paired devices
// stay paired; without it the home is rebuilt and devices must pair again)
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { createProject, prepareHome, startEnvironment } from "../../scripts/stage-env.mjs";

if (!process.argv[2]) throw new Error("usage: serve.mjs <out-dir> [--reuse]");
const OUT = NodePath.resolve(process.argv[2]);
const REUSE = process.argv.includes("--reuse");
NodeFS.mkdirSync(OUT, { recursive: true });
const HOME = NodePath.join(OUT, "home");
const PREVIEW_PORT = 5199;
const LINEAR_PORT = 5201;

// 1. Live demo web app on localhost:5199
const DEMO_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0b0f1a" />
  <title>Mugshot — Studio</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, sans-serif;
      background: radial-gradient(circle at 50% -6%, #1d3266 0%, #0b0f1a 42%, #07090f 100%);
      color: #f3f6fc; padding: 18px 18px 120px; -webkit-font-smoothing: antialiased;
    }
    .nav { display: flex; align-items: center; justify-content: space-between; padding: 6px 0 20px; }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 17px; letter-spacing: -0.02em; }
    .dot { width: 26px; height: 26px; border-radius: 8px; background: linear-gradient(135deg, #4f86ff, #8b5cf6); display: grid; place-items: center; font-size: 13px; font-weight: 800; }
    .pill { font-size: 12px; font-weight: 600; color: #93c5fd; background: rgba(59,130,246,0.16); border: 1px solid rgba(59,130,246,0.35); padding: 6px 12px; border-radius: 999px; }
    .hero { padding: 8px 0 22px; }
    .hero h1 { font-size: 32px; line-height: 1.08; font-weight: 800; letter-spacing: -0.035em; background: linear-gradient(180deg, #fff 30%, #9fb3d9 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .hero p { margin-top: 12px; font-size: 15px; line-height: 1.5; color: #98a6bf; }
    .cta-row { display: flex; gap: 10px; margin-top: 18px; }
    .btn { flex: 1; text-align: center; padding: 13px 16px; border-radius: 12px; font-size: 14px; font-weight: 650; border: 0; color: inherit; cursor: pointer; }
    .btn.primary { background: #3b82f6; color: #fff; box-shadow: 0 8px 24px rgba(59,130,246,0.35); }
    .btn.ghost { background: rgba(255,255,255,0.07); color: #e2e8f0; border: 1px solid rgba(255,255,255,0.1); }
    .metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 22px; }
    .card { background: rgba(18,24,38,0.85); border: 1px solid rgba(255,255,255,0.09); border-radius: 16px; padding: 16px; }
    .card .label { font-size: 12px; color: #8c9bb8; font-weight: 500; }
    .card .val { font-size: 26px; font-weight: 750; margin-top: 6px; letter-spacing: -0.03em; }
    .card .delta { font-size: 12px; color: #4ade80; margin-top: 4px; font-weight: 600; }
    .section { margin-top: 26px; }
    .section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .section h2 { font-size: 16px; font-weight: 700; letter-spacing: -0.02em; }
    .tune-btn { font-size: 13px; font-weight: 650; color: #93c5fd; background: rgba(59,130,246,0.16); border: 1px solid rgba(59,130,246,0.38); padding: 6px 12px; border-radius: 10px; }
    .preset { display: flex; align-items: center; justify-content: space-between; background: rgba(18,24,38,0.82); border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 14px 16px; margin-bottom: 10px; }
    .preset.active { border-color: rgba(59,130,246,0.65); background: rgba(30,50,92,0.55); }
    .preset .name { font-size: 15px; font-weight: 600; }
    .preset .sub { font-size: 12px; color: #8c9bb8; margin-top: 2px; }
    .badge { font-size: 11px; font-weight: 700; padding: 4px 9px; border-radius: 8px; background: rgba(255,255,255,0.08); color: #cbd5e1; }
    .preset.active .badge { background: rgba(74,222,128,0.16); color: #4ade80; }
    .rim { margin-top: 4px; background: rgba(18,24,38,0.85); border: 1px solid rgba(59,130,246,0.45); border-radius: 16px; padding: 16px; }
    .rim .row { display: flex; justify-content: space-between; align-items: baseline; }
    .rim .t { font-size: 14px; font-weight: 650; }
    .rim .k { font-size: 22px; font-weight: 750; letter-spacing: -0.02em; }
    .rim .track { position: relative; height: 6px; border-radius: 99px; background: rgba(255,255,255,0.1); margin: 16px 0 10px; }
    .rim .fill { position: absolute; inset: 0 38% 0 0; border-radius: 99px; background: linear-gradient(90deg, #f59e0b, #3b82f6); }
    .rim .knob { position: absolute; left: 62%; top: -8px; width: 22px; height: 22px; margin-left: -11px; border-radius: 50%; background: #fff; box-shadow: 0 2px 10px rgba(0,0,0,0.5); }
    .rim .ticks { display: flex; justify-content: space-between; font-size: 11px; color: #8c9bb8; }
    .rim .ok { margin-top: 10px; font-size: 12px; font-weight: 600; color: #4ade80; }
  </style>
</head>
<body>
  <div class="nav"><div class="brand"><div class="dot">M</div>Mugshot</div><div class="pill">HMR Live · :5199</div></div>
  <div class="hero">
    <h1>Studio portraits,<br/>rendered in 120ms.</h1>
    <p>Upload one raw shot, dial in lighting presets, and export crisp 4K avatars for your whole team.</p>
    <div class="cta-row"><div class="btn primary">Studio settings</div><div class="btn ghost">Compare raw</div></div>
  </div>
  <div class="rim"><div class="row"><div class="t">Rim fill · Nordic Softbox</div><div class="k">5,250K</div></div><div class="track"><div class="fill"></div><div class="knob"></div></div><div class="ticks"><span>3,200K</span><span>50K steps</span><span>6,500K</span></div><div class="ok">✓ Smooth — MUG-142 fixed</div></div>
  <div class="metrics">
    <div class="card"><div class="label">Render p95</div><div class="val">118 ms</div><div class="delta">−42% vs v2.3</div></div>
    <div class="card"><div class="label">Active presets</div><div class="val">24</div><div class="delta">6 studio LUTs</div></div>
  </div>
  <div class="section">
    <div class="section-head"><h2>Lighting presets</h2><button class="tune-btn">⚙ Settings</button></div>
    <div class="preset active"><div><div class="name">Nordic Softbox</div><div class="sub">5600K · F/2.0 · Rim fill</div></div><div class="badge">Active</div></div>
    <div class="preset"><div><div class="name">Editorial Noir</div><div class="sub">4200K · High contrast · Matte</div></div><div class="badge">Ready</div></div>
    <div class="preset"><div><div class="name">Golden Hour</div><div class="sub">3800K · Warm bounce · Soft</div></div><div class="badge">Ready</div></div>
    <div class="preset"><div><div class="name">Clean Daylight</div><div class="sub">6000K · Neutral · Crisp</div></div><div class="badge">Ready</div></div>
    <div class="preset"><div><div class="name">Studio Cobalt</div><div class="sub">5200K · Cool key · Blue edge</div></div><div class="badge">Ready</div></div>
    <div class="preset"><div><div class="name">Film Grain 400</div><div class="sub">4800K · Organic texture</div></div><div class="badge">Ready</div></div>
  </div>
</body>
</html>`;

const previewServer = NodeHttp.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(DEMO_HTML);
});
await new Promise((resolve) => previewServer.listen(PREVIEW_PORT, "127.0.0.1", resolve));

// 2. Mock Linear GraphQL server for realistic fictional acme/mugshot issues!
const USERS = {
  dana: {
    id: "u-dana",
    name: "Dana Reyes",
    displayName: "Dana",
    email: "dana@example.com",
    avatarUrl: null,
  },
  sam: {
    id: "u-sam",
    name: "Sam Chen",
    displayName: "Sam",
    email: "sam@example.com",
    avatarUrl: null,
  },
  maya: {
    id: "u-maya",
    name: "Maya Patel",
    displayName: "Maya",
    email: "maya@example.com",
    avatarUrl: null,
  },
};
const STATES = [
  { id: "st-todo", name: "Todo", type: "unstarted", position: 1 },
  { id: "st-prog", name: "In Progress", type: "started", position: 2 },
  { id: "st-rev", name: "In Review", type: "started", position: 3 },
  { id: "st-done", name: "Done", type: "completed", position: 4 },
];
const LABELS = {
  ui: { id: "lbl-ui", name: "UI", color: "#5e6ad2", description: "Interface polish" },
  perf: { id: "lbl-perf", name: "Performance", color: "#26b5ce", description: "Latency & memory" },
  mobile: { id: "lbl-mob", name: "Mobile", color: "#4ea7fc", description: "iOS & Android" },
  bug: { id: "lbl-bug", name: "Bug", color: "#eb5757", description: "Defect" },
};
const ISSUES = [
  {
    id: "iss-142",
    identifier: "MUG-142",
    number: 142,
    title: "Warm rim-fill slider jumps on Nordic Softbox preset",
    url: "https://linear.app/acme/issue/MUG-142",
    createdAt: "2026-11-25T16:10:00.000Z",
    updatedAt: "2026-11-25T20:15:00.000Z",
    completedAt: null,
    canceledAt: null,
    state: STATES[1],
    team: { key: "MUG", states: { nodes: STATES } },
    creator: USERS.dana,
    botActor: null,
    assignee: USERS.dana,
    labels: { nodes: [LABELS.ui, LABELS.mobile] },
    description:
      "When adjusting the rim-fill intensity on **Nordic Softbox**, the preview LUT snaps by 400K instead of interpolating smoothly.\n\n### Expected\n- Smooth 50K steps from 3200K to 6500K\n- Preserve skin texture toggle stays synced with live preview",
    comments: {
      nodes: [
        {
          id: "c-1",
          body: "Reproduced on localhost:5199 — looks like the LUT cache key rounds temperature to 500K buckets.",
          createdAt: "2026-11-25T18:20:00.000Z",
          url: "https://linear.app/acme/issue/MUG-142#comment-1",
          user: USERS.sam,
          botActor: null,
          reactions: [],
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    reactions: [],
    attachments: { nodes: [] },
    history: { nodes: [] },
  },
  {
    id: "iss-139",
    identifier: "MUG-139",
    number: 139,
    title: "Defer studio LUT thumbnail decode until preset list scrolls into view",
    url: "https://linear.app/acme/issue/MUG-139",
    createdAt: "2026-11-24T19:00:00.000Z",
    updatedAt: "2026-11-25T19:40:00.000Z",
    completedAt: null,
    canceledAt: null,
    state: STATES[2],
    team: { key: "MUG", states: { nodes: STATES } },
    creator: USERS.sam,
    botActor: null,
    assignee: USERS.sam,
    labels: { nodes: [LABELS.perf] },
    description:
      "Cuts initial p95 studio render latency from 204ms down to 118ms on mobile viewports.",
    comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    reactions: [],
    attachments: { nodes: [] },
    history: { nodes: [] },
  },
  {
    id: "iss-136",
    identifier: "MUG-136",
    number: 136,
    title: "Add Editorial Noir & Golden Hour batch export presets",
    url: "https://linear.app/acme/issue/MUG-136",
    createdAt: "2026-11-23T14:00:00.000Z",
    updatedAt: "2026-11-25T14:12:00.000Z",
    completedAt: null,
    canceledAt: null,
    state: STATES[0],
    team: { key: "MUG", states: { nodes: STATES } },
    creator: USERS.maya,
    botActor: null,
    assignee: USERS.maya,
    labels: { nodes: [LABELS.ui] },
    description: "Support 4K WebP + PNG export profiles for team portrait batches.",
    comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    reactions: [],
    attachments: { nodes: [] },
    history: { nodes: [] },
  },
  {
    id: "iss-131",
    identifier: "MUG-131",
    number: 131,
    title: "Fix EXIF orientation flip on RAW portrait uploads",
    url: "https://linear.app/acme/issue/MUG-131",
    createdAt: "2026-11-22T11:30:00.000Z",
    updatedAt: "2026-11-24T22:10:00.000Z",
    completedAt: null,
    canceledAt: null,
    state: STATES[0],
    team: { key: "MUG", states: { nodes: STATES } },
    creator: USERS.dana,
    botActor: null,
    assignee: USERS.sam,
    labels: { nodes: [LABELS.bug, LABELS.mobile] },
    description: "Portrait RAW files shot on iPhone rotate 90deg in the compare-raw preview.",
    comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    reactions: [],
    attachments: { nodes: [] },
    history: { nodes: [] },
  },
];

// Mock Linear that also accepts writes, so state moves and comments stick.
const MUG_TEAM_STATES = STATES;
const now = () => new Date().toISOString();
let seq = 0;
const linearServer = NodeHttp.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { query = "", variables = {}, operationName = "" } = JSON.parse(body || "{}");
    const op = operationName || (/(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "");
    const findIssue = (id) =>
      ISSUES.find((i) => i.identifier === id || i.id === id || id?.endsWith?.(i.identifier)) ??
      ISSUES[0];
    let data = {};
    if (op === "T3IssueUpdate") {
      const issue = findIssue(variables.id);
      const input = variables.input ?? {};
      if (input.stateId) {
        const to = MUG_TEAM_STATES.find((s) => s.id === input.stateId);
        if (to) {
          issue.history.nodes.push({
            id: `h-${++seq}`,
            createdAt: now(),
            actor: USERS.dana,
            botActor: null,
            fromState: issue.state,
            toState: to,
            fromAssignee: null,
            toAssignee: null,
            addedLabels: [],
            removedLabels: [],
            fromTitle: null,
            toTitle: null,
          });
          issue.state = to;
        }
      }
      issue.updatedAt = now();
      data = { issueUpdate: { success: true } };
    } else if (op === "T3CommentCreate") {
      const input = variables.input ?? {};
      const issue = findIssue(input.issueId);
      issue.comments.nodes.push({
        id: `c-${++seq}`,
        body: input.body ?? "",
        createdAt: now(),
        url: `${issue.url}#comment-${seq}`,
        user: USERS.dana,
        botActor: null,
        reactions: [],
      });
      issue.updatedAt = now();
      data = { commentCreate: { success: true } };
    } else if (op === "T3ReactionCreate") {
      data = { reactionCreate: { success: true } };
    } else if (op === "T3ReactionDelete") {
      data = { reactionDelete: { success: true } };
    } else if (op === "T3Viewer") {
      data = {
        viewer: USERS.dana,
        organization: { urlKey: "acme" },
        teams: { nodes: [{ id: "team-mug", key: "MUG", name: "Mugshot" }] },
      };
    } else if (op === "T3Issues") {
      data = { issues: { nodes: ISSUES, pageInfo: { hasNextPage: false, endCursor: null } } };
    } else if (op === "T3Issue" || op === "T3IssueReactions") {
      data = { issue: findIssue(variables.id) };
    } else if (op === "T3Comments") {
      data = { issue: { comments: findIssue(variables.id).comments } };
    } else if (op === "T3Team") {
      data = {
        teams: {
          nodes: [
            {
              id: "team-mug",
              key: "MUG",
              name: "Mugshot",
              states: { nodes: STATES, pageInfo: { hasNextPage: false, endCursor: null } },
              labels: {
                nodes: Object.values(LABELS),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
              members: {
                nodes: Object.values(USERS),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
              templates: { nodes: [] },
            },
          ],
        },
        issueLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      };
    } else {
      console.error("linear: unhandled op", op);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data }));
  });
});
await new Promise((resolve) => linearServer.listen(LINEAR_PORT, "127.0.0.1", resolve));

const PRESETS = (rimFill) =>
  `export const PRESETS = [\n  { id: "nordic", name: "Nordic Softbox", kelvin: 5600, aperture: "F/2.0"${rimFill} },\n  { id: "noir", name: "Editorial Noir", kelvin: 4200, aperture: "F/1.8" },\n  { id: "golden", name: "Golden Hour", kelvin: 3800, aperture: "F/1.4" },\n];\n`;
const PRESETS_FIXED = PRESETS(", rimFillStepK: 50");
const title = (text, match) => ({ match: `"title"[\\s\\S]*${match}`, json: { title: text } });
// Turn order matters: a /btw side chat's prompt carries the parent's history, so its turn comes
// before the MUG-142 turn and matches only the question.
const TURNS = [
  title("Fix rim-fill slider jumps", "MUG-142"),
  title("LUT cache audit", "LUT cache"),
  title("Why 50K steps?", "50K"),
  title("Redesign studio lighting preview page", "lighting preview cards"),
  title("Mugshot studio", ""),
  {
    match: "why 50K steps",
    steps: [
      {
        text: "50K is the smallest change a viewer can see on skin tones at this exposure, so the slider feels continuous without re-rendering the LUT on every pixel of drag. 100K steps would bring the visible jump back on Nordic Softbox's warm rim.",
      },
    ],
  },
  {
    match: "Profile the studio LUT cache",
    steps: [
      { think: "Find where the LUT cache builds its key from the preset temperature." },
      {
        bash: 'rg -n "cacheKey" src/lut',
        output:
          "src/lut/cache.ts:42:  const cacheKey = `${preset.id}:${Math.round(kelvin / 500) * 500}`;",
        ms: 900,
      },
      {
        text: "Found it: `src/lut/cache.ts:42` rounds Kelvin to 500K buckets before building the cache key, so a 50K slider step only changes the preview when it crosses a bucket — that's the jump in MUG-142.",
      },
    ],
  },
  {
    match: "MUG-142",
    steps: [
      {
        think:
          "Read MUG-142, link it to this thread, and have a subagent audit the LUT cache while I fix the slider.",
      },
      { tool: "link_issue", input: { url: "https://linear.app/acme/issue/MUG-142" } },
      {
        text: "Linked **MUG-142**. I'll send a subagent to audit the LUT cache while I fix the slider step.",
      },
      {
        tool: "delegate_task",
        input: {
          title: "LUT cache audit",
          task: "Profile the studio LUT cache and report how it buckets preset temperature in its cache key.",
          target: { environmentId: "<var:environmentId>", projectId: "<var:projectId>" },
        },
        as: "taskId",
        pick: '(?<="taskId":")[^"]+',
      },
      { write: "src/presets.ts", content: PRESETS_FIXED },
      {
        bash: "pnpm test presets",
        output:
          " ✓ src/presets.test.ts (6 tests) 41ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)",
        ms: 1400,
      },
      { wait: 1500, tool: "task_status", input: { taskId: "<var:taskId>" } },
      {
        text: "**MUG-142 is fixed.** The **LUT cache audit** subagent found the cause: the cache key rounded Kelvin to 500K buckets, so every drag snapped.\n\n- Rim fill now moves in smooth **50K steps** on Nordic Softbox\n- The LUT cache keys on the exact temperature\n- Preset tests pass\n\nThe dev server is running at http://localhost:5199 — open it here to try the slider.",
      },
    ],
  },
  {
    match: "lighting preview cards",
    steps: [
      {
        think:
          "Let's update the Mugshot Studio lighting preset cards and start the dev server on port 5199.",
      },
      {
        bash: "pnpm dev --port 5199",
        output: "VITE v6.2.1 ready in 184 ms\n  ➜  Local:   http://localhost:5199/",
        ms: 250,
      },
      {
        text: "Updated the **Mugshot Studio** preview layout with the new lighting preset cards and p95 render telemetry.\n\nThe dev server is live at http://localhost:5199 — you can open it right on this device to check the scroll and touch feel.\n\nKey changes:\n- Added the **Nordic Softbox** and **Editorial Noir** preset cards with live badges\n- Tuned the hero gradient and typography hierarchy for compact mobile viewports\n- Cut initial render latency by 42% by deferring LUT preview thumbnails",
      },
    ],
  },
];

const STAGE = NodePath.join(OUT, "stage.json");
const prior =
  REUSE && NodeFS.existsSync(STAGE) ? JSON.parse(NodeFS.readFileSync(STAGE, "utf8")) : null;
if (REUSE && !prior) throw new Error(`--reuse needs ${STAGE} from an earlier run`);
if (prior) NodeFS.writeFileSync(NodePath.join(HOME, "claude-script.json"), JSON.stringify(TURNS));
else prepareHome(HOME, { label: "devbox", machine: "mac-studio", claude: TURNS });

const VARS = NodePath.join(HOME, "replay-vars.json");
const env = await startEnvironment(HOME, {
  host: "127.0.0.1",
  ...(prior ? { port: prior.serverPort } : {}),
  env: {
    T3CODE_LINEAR_API_URL: `http://127.0.0.1:${LINEAR_PORT}/graphql`,
    FAKE_CLAUDE_VARS: VARS,
  },
});
const project = prior
  ? { projectId: prior.projectId, workspace: prior.workspace }
  : await createProject(env, "mugshot", {
      "README.md": "# acme/mugshot\n\nStudio portrait renderer for teams.\n",
      "src/app.tsx": `import { PRESETS } from "./presets";\n\nexport function MugshotStudio() {\n  return (\n    <main className="studio-grid">\n      <h1>Studio portraits, rendered in 120ms.</h1>\n      {PRESETS.map((p) => (\n        <PresetCard key={p.id} preset={p} />\n      ))}\n    </main>\n  );\n}\n`,
      "src/presets.ts": PRESETS(""),
    });
if (prior) NodeFS.writeFileSync(NodePath.join(project.workspace, "src/presets.ts"), PRESETS(""));
NodeFS.writeFileSync(
  VARS,
  JSON.stringify({ environmentId: env.environmentId, projectId: project.projectId }),
);
const stageInfo = {
  home: HOME,
  origin: env.origin,
  serverPort: env.serverPort,
  environmentId: env.environmentId,
  projectId: project.projectId,
  workspace: project.workspace,
  previewUrl: `http://localhost:${PREVIEW_PORT}`,
  linearUrl: `http://127.0.0.1:${LINEAR_PORT}/graphql`,
};
NodeFS.writeFileSync(STAGE, JSON.stringify(stageInfo, null, 2));
console.log(
  "STAGE_READY",
  JSON.stringify({ origin: env.origin, environmentId: env.environmentId }),
);
await new Promise(() => {});
