import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { highlightTS } from "../marketing/highlightTS";

/**
 * Showcase for the "Compose Effects and Layers..." (Effect-pilled) section.
 *
 * Single terminal-chromed card with a tab strip in the header and one
 * focused example per tab. Each panel pairs a trimmed code snippet (left)
 * with a stylized "generated artifact" panel (right) that visually proves
 * what Alchemy wired up. Tabs auto-cycle while in view; tap to pin.
 *
 * Tabs:
 *   - IAM bindings   — `S3.GetObject.bind(...)` → permissions + env vars
 *   - Event sources  — `DynamoDB.stream(...).process(...)` → EventSourceMapping
 *   - Durable Objects — `Cloudflare.DurableObjectNamespace`
 *   - Containers     — `Cloudflare.Container`
 *   - Workflows      — `Cloudflare.Workflow`
 *   - Layers         — `Layer.effect(JobStorage, ...)`
 */

type Tab = "iam" | "stream" | "do" | "container" | "workflow" | "layer";

const TABS: { id: Tab; label: string }[] = [
  { id: "iam", label: "IAM bindings" },
  { id: "stream", label: "Event sources" },
  { id: "do", label: "Durable Objects" },
  { id: "container", label: "Containers" },
  { id: "workflow", label: "Workflows" },
  { id: "layer", label: "Layers" },
];

const CYCLE_MS = 6000;
/** Longer dwell on the Layer tab so both impls (ddb / d1) get airtime. */
const LAYER_CYCLE_MS = 13000;
/** How long each Layer impl is "held" before the breathing cross-fade swaps. */
const LAYER_IMPL_SWAP_MS = 3500;

const IAM_CODE = `export default AWS.Lambda.Function(
  "JobApi",
  Effect.gen(function* () {
    const getPhoto = yield* S3.GetObject.bind(Photos);
    const putJob   = yield* DynamoDB.PutItem.bind(Jobs);

    return {
      fetch: Effect.gen(function* () {
        const req = yield* HttpServerRequest;
        return yield* getPhoto({ key: req.url.slice(1) });
      }),
    };
  }),
);`;

const STREAM_CODE = `export default AWS.Lambda.Function(
  "JobsConsumer",
  Effect.gen(function* () {
    yield* DynamoDB.stream(Jobs).process((stream) =>
      stream.pipe(
        Stream.map((r) => r.dynamodb.NewImage),
        Stream.tap((job) => Effect.log(\`new job: \${job.id.S}\`)),
        Stream.runDrain,
      ),
    );
  }),
);`;

const DO_CODE = `export default class Room extends Cloudflare.DurableObjectNamespace<Room>()(
  "Rooms",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const sessions = new Map<string, Cloudflare.DurableWebSocket>();

      return {
        fetch: Effect.gen(function* () {
          const [response, socket] = yield* Cloudflare.upgrade();
          sessions.set(crypto.randomUUID(), socket);
          return response;
        }),
      };
    });
  }),
) {}`;

const CONTAINER_CODE = `export class Sandbox extends Cloudflare.Container<Sandbox, {
  exec: (cmd: string) => Effect.Effect<ExecResult>;
}>()(
  "Sandbox",
  Stack.useSync((stack) => ({
    instanceType: stack.stage === "prod" ? "standard-1" : "dev",
  })),
) {}

export const SandboxLive = Sandbox.make(
  Effect.gen(function* () {
    const cp = yield* ChildProcessSpawner;
    return Sandbox.of({
      exec: (cmd) => cp.spawn(ChildProcess.make(cmd, { shell: true })),
    });
  }),
);`;

const WORKFLOW_CODE = `export default class Notifier extends Cloudflare.Workflow<Notifier>()(
  "Notifier",
  Effect.gen(function* () {
    const rooms = yield* Room;
    return Effect.gen(function* () {
      const { roomId, message } = (yield* Cloudflare.WorkflowEvent).payload;
      yield* Cloudflare.task("store",     rooms.getByName(roomId).store(message));
      yield* Cloudflare.task("process",   processMessage(message));
      yield* Cloudflare.task("broadcast", rooms.getByName(roomId).broadcast(message));
      yield* Cloudflare.sleep("cooldown", "2 seconds");
      yield* Cloudflare.task("finalize",  rooms.getByName(roomId).cleanup());
    });
  }),
) {}`;

type LayerImpl = "ddb" | "d1";

/**
 * The Layer tab renders a structural diff between JobStorageDynamoDB and
 * JobStorageD1. The two snippets are split into segments: "common" lines
 * stay static; each "diff" segment overlays the ddb and d1 variants in the
 * same grid cell so the inactive one fully hides (opacity 0) and the active
 * one occupies that space — crossfading smoothly between them.
 *
 * Structurally parallel layout keeps the diff readable column-for-column.
 */
type LayerSegment =
  | { kind: "common"; lines: string[] }
  | { kind: "diff"; ddb: string[]; d1: string[] };

const LAYER_SEGMENTS: LayerSegment[] = [
  {
    kind: "common",
    lines: [
      "export class JobStorage extends Context.Service<JobStorage, {",
      "  putJob: (job: Job) => Effect.Effect<Job, PutJobError>;",
      "  getJob: (id: string) => Effect.Effect<Job | undefined, GetJobError>;",
      '}>()("JobStorage") {}',
      "",
    ],
  },
  {
    kind: "diff",
    ddb: [
      "export const JobStorageDynamoDB = Layer.effect(JobStorage, Effect.gen(function* () {",
      '  const table   = yield* DynamoDB.Table("JobsTable", { partitionKey: "id" });',
      "  const putItem = yield* DynamoDB.PutItem.bind(table);",
      "  const getItem = yield* DynamoDB.GetItem.bind(table);",
    ],
    d1: [
      "export const JobStorageD1 = Layer.effect(JobStorage, Effect.gen(function* () {",
      '  const db   = yield* Cloudflare.D1Database("JobsDB");',
      "  const conn = yield* Cloudflare.D1Connection.bind(db);",
      "",
    ],
  },
  {
    kind: "common",
    lines: ["  return JobStorage.of({"],
  },
  {
    kind: "diff",
    ddb: [
      "    putJob: (job) => putItem({ Item: { id: { S: job.id } } }),",
      "    getJob: (id)  => getItem({ Key:  { id: { S: id     } } }),",
    ],
    d1: [
      "    putJob: (job) => conn.exec(`INSERT INTO jobs (id) VALUES ('${job.id}')`),",
      "    getJob: (id)  => conn.exec(`SELECT * FROM jobs WHERE id = '${id}'`),",
    ],
  },
  {
    kind: "common",
    lines: ["  });", "}));"],
  },
];

const CODE_BY_TAB: Record<Exclude<Tab, "layer">, string> = {
  iam: IAM_CODE,
  stream: STREAM_CODE,
  do: DO_CODE,
  container: CONTAINER_CODE,
  workflow: WORKFLOW_CODE,
};

export default function EffectPilledShowcase() {
  const [tab, setTab] = useState<Tab>("iam");
  const [pinned, setPinned] = useState(false);
  const [layerImpl, setLayerImpl] = useState<LayerImpl>("ddb");
  const wrapRef = useRef<HTMLDivElement>(null);

  // Tab auto-cycle. Dwell longer on the Layer tab so both impls show
  // before moving on to the next tab.
  useEffect(() => {
    if (pinned) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      const dwell = tab === "layer" ? LAYER_CYCLE_MS : CYCLE_MS;
      timer = setTimeout(() => {
        if (cancelled) return;
        setTab((t) => {
          const idx = TABS.findIndex((x) => x.id === t);
          return TABS[(idx + 1) % TABS.length]!.id;
        });
      }, dwell);
    };

    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            schedule();
          } else if (timer) {
            clearTimeout(timer);
            timer = null;
          }
        }
      },
      { threshold: 0.3 },
    );
    if (wrapRef.current) obs.observe(wrapRef.current);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      obs.disconnect();
    };
  }, [tab, pinned]);

  // Inner oscillation for the Layer tab — swap between ddb and d1
  // implementations on a separate timer. Resets to "ddb" whenever we
  // leave the tab so the user always sees the Dynamo example first.
  useEffect(() => {
    if (tab !== "layer") {
      setLayerImpl("ddb");
      return;
    }
    let cancelled = false;
    const timer = setInterval(() => {
      if (cancelled) return;
      setLayerImpl((i) => (i === "ddb" ? "d1" : "ddb"));
    }, LAYER_IMPL_SWAP_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tab]);

  const onTab = (next: Tab) => {
    setPinned(true);
    setTab(next);
  };

  const codeHtml = tab === "layer" ? null : highlightTS(CODE_BY_TAB[tab]);
  // Drives the fade-in for the whole panel on tab switch. Intentionally
  // does NOT include layerImpl — the Layer tab uses CSS transitions to
  // breathe between its two impls without remounting.
  const splitKey = tab;

  return (
    <div ref={wrapRef} className="eff-showcase">
      <div className="eff-showcase__chrome">
        <div className="eff-showcase__header">
          <span
            className="alc-code-block__dot"
            style={{ background: "var(--alc-danger)" }}
          />
          <span
            className="alc-code-block__dot"
            style={{ background: "var(--alc-warn)" }}
          />
          <span
            className="alc-code-block__dot"
            style={{ background: "var(--alc-accent-bright)" }}
          />
          <div className="eff-showcase__tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className="eff-showcase__tab"
                data-active={tab === t.id}
                onClick={() => onTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="eff-showcase__body">
          <div className="eff-showcase__split" key={splitKey}>
            <div className="eff-showcase__code">
              {tab === "layer" ? (
                <LayerCodeDiff impl={layerImpl} />
              ) : (
                <pre
                  className="eff-showcase__pre eff-showcase__fade"
                  dangerouslySetInnerHTML={{ __html: codeHtml ?? "" }}
                />
              )}
            </div>
            <div className="eff-showcase__artifact">
              <ArtifactPanel tab={tab} layerImpl={layerImpl} />
            </div>
          </div>
        </div>
      </div>
      <div className="eff-showcase__hint" aria-hidden>
        {pinned ? (
          <span>tap a tab to switch</span>
        ) : (
          <span>cycling · tap to pin</span>
        )}
      </div>
    </div>
  );
}

function ArtifactPanel({ tab, layerImpl }: { tab: Tab; layerImpl: LayerImpl }) {
  switch (tab) {
    case "iam":
      return <IamPanel />;
    case "stream":
      return <StreamPanel />;
    case "do":
      return <DurableObjectPanel />;
    case "container":
      return <ContainerPanel />;
    case "workflow":
      return <WorkflowPanel />;
    case "layer":
      return <LayerPanel impl={layerImpl} />;
  }
}

/* ───────────────────────── IAM bindings ───────────────────────── */

function IamPanel() {
  const PERMISSIONS = [
    { icon: "logos:aws-s3", action: "s3:GetObject", target: "Photos/*" },
    { icon: "logos:aws-dynamodb", action: "dynamodb:PutItem", target: "Jobs" },
  ];
  const ENV_VARS = [
    { name: "PHOTOS_BUCKET", value: "arn:aws:s3:::photos-…" },
    { name: "JOBS_TABLE", value: "arn:aws:dynamodb:…:table/Jobs-…" },
  ];
  return (
    <>
      <div className="eff-showcase__group">
        <div className="eff-showcase__group-title">Permissions</div>
        {PERMISSIONS.map((p, i) => (
          <div
            className="eff-showcase__perm"
            key={p.action}
            style={{ animationDelay: `${120 + i * 120}ms` }}
          >
            <Icon
              icon={p.icon}
              width={20}
              height={20}
              aria-hidden
              className="eff-showcase__perm-icon"
            />
            <span className="eff-showcase__perm-action">{p.action}</span>
            <span className="eff-showcase__perm-arrow" aria-hidden>
              →
            </span>
            <span className="eff-showcase__perm-target">{p.target}</span>
          </div>
        ))}
      </div>
      <div className="eff-showcase__group">
        <div className="eff-showcase__group-title">Environment</div>
        <div className="eff-showcase__envs">
          {ENV_VARS.map((e, i) => (
            <div
              className="eff-showcase__env"
              key={e.name}
              style={{ animationDelay: `${360 + i * 100}ms` }}
            >
              <span className="eff-showcase__env-name">{e.name}</span>
              <span className="eff-showcase__env-eq" aria-hidden>
                =
              </span>
              <span className="eff-showcase__env-value">{e.value}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/* ───────────────────────── Event sources ───────────────────────── */

function StreamPanel() {
  return (
    <div className="eff-showcase__group">
      <div className="eff-showcase__group-title">Wired event source</div>
      <div className="eff-showcase__flow">
        <FlowNode
          icon="logos:aws-dynamodb"
          label="Jobs"
          sub="DynamoDB.Table"
          delay={120}
        />
        <FlowEdge label="stream" delay={260} />
        <FlowNode
          icon="logos:aws-lambda"
          label="EventSourceMapping"
          sub="created by alchemy"
          accent
          delay={320}
        />
        <FlowEdge label="invoke" delay={440} />
        <FlowNode
          icon="mdi:lambda"
          label="handler"
          sub="your function"
          delay={500}
        />
      </div>
    </div>
  );
}

/* ───────────────────────── Durable Objects ───────────────────────── */

function DurableObjectPanel() {
  const FEATURES = [
    {
      icon: "logos:cloudflare-icon",
      label: "Cloudflare.DurableObjectNamespace",
      sub: "one instance per name · single-threaded",
    },
    {
      icon: "mdi:database",
      label: "DurableObjectState",
      sub: "per-instance SQLite, persists across restarts",
    },
    {
      icon: "mdi:transit-connection-variant",
      label: "WebSocket sessions",
      sub: "hibernation-safe via serializeAttachment",
    },
  ];
  return (
    <div className="eff-showcase__group">
      <div className="eff-showcase__group-title">Generated DO</div>
      {FEATURES.map((f, i) => (
        <FeatureRow key={f.label} {...f} delay={120 + i * 120} />
      ))}
    </div>
  );
}

/* ───────────────────────── Containers ───────────────────────── */

function ContainerPanel() {
  const FEATURES = [
    {
      icon: "logos:docker-icon",
      label: "Image",
      sub: "built from Dockerfile · pushed to registry",
    },
    {
      icon: "mdi:server",
      label: "Instance",
      sub: "dev → 256 MB · prod → standard-1",
    },
    {
      icon: "mdi:console",
      label: "exec(cmd)",
      sub: "typed Effect · spawns via ChildProcessSpawner",
    },
  ];
  return (
    <div className="eff-showcase__group">
      <div className="eff-showcase__group-title">Generated container</div>
      {FEATURES.map((f, i) => (
        <FeatureRow key={f.label} {...f} delay={120 + i * 120} />
      ))}
    </div>
  );
}

/* ───────────────────────── Workflows ───────────────────────── */

function WorkflowPanel() {
  const STEPS = [
    { label: "store", sub: "task · durable retry" },
    { label: "process", sub: "task · pure transform" },
    { label: "broadcast", sub: "task · DO call" },
    { label: "cooldown", sub: "sleep · 2 seconds" },
    { label: "finalize", sub: "task · DO call" },
  ];
  return (
    <div className="eff-showcase__group">
      <div className="eff-showcase__group-title">Workflow steps</div>
      <div className="eff-showcase__steps">
        {STEPS.map((s, i) => (
          <div
            className="eff-showcase__step"
            key={s.label}
            style={{ animationDelay: `${100 + i * 90}ms` }}
          >
            <span className="eff-showcase__step-num">{i + 1}</span>
            <span className="eff-showcase__step-label">{s.label}</span>
            <span className="eff-showcase__step-sub">{s.sub}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────── Layers ───────────────────────── */

function LayerPanel({ impl }: { impl: LayerImpl }) {
  // The "Composed from" group overlays the ddb and d1 row-stacks in the
  // same grid cell so only the active variant is visible. Same crossfade
  // pattern as the code diff on the left.
  return (
    <>
      <div className="eff-showcase__group">
        <div className="eff-showcase__group-title">Provides</div>
        <FeatureRow
          icon="mdi:layers-triple"
          label="JobStorage"
          sub="Context.Service · putJob · getJob"
          delay={120}
        />
      </div>
      <div className="eff-showcase__group">
        <div className="eff-showcase__group-title">Composed from</div>
        <div className="eff-showcase__variant-stack">
          <div
            className="eff-showcase__variant"
            data-active={impl === "ddb"}
            aria-hidden={impl !== "ddb"}
          >
            <FeatureRow
              icon="logos:aws-dynamodb"
              label="DynamoDB.Table"
              sub='"JobsTable" · partitionKey: "id"'
              delay={240}
            />
            <FeatureRow
              icon="mdi:key"
              label="GetItem · PutItem"
              sub="bound capabilities · IAM auto-generated"
              delay={340}
            />
          </div>
          <div
            className="eff-showcase__variant"
            data-active={impl === "d1"}
            aria-hidden={impl !== "d1"}
          >
            <FeatureRow
              icon="logos:cloudflare-icon"
              label="Cloudflare.D1Database"
              sub='"JobsDB" · serverless SQL'
              delay={240}
            />
            <FeatureRow
              icon="mdi:database-cog"
              label="D1Connection"
              sub="bound capability · prepare · exec · batch"
              delay={340}
            />
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Layer-tab code panel. Common lines render statically; each diff segment is
 * an overlay (CSS grid with both variants in the same grid cell) so only the
 * active variant is visible while the inactive one fades to opacity 0. The
 * slot's height is the max of both variants, so the panel stays stable as
 * the active impl swaps.
 */
function LayerCodeDiff({ impl }: { impl: LayerImpl }) {
  return (
    <div className="eff-showcase__diff">
      {LAYER_SEGMENTS.map((seg, i) => {
        if (seg.kind === "common") {
          return (
            <div key={i} className="eff-diff__common">
              {seg.lines.map((line, j) => (
                <CodeLine key={j} text={line} kind="common" />
              ))}
            </div>
          );
        }
        return (
          <div key={i} className="eff-diff__slot">
            <div
              className="eff-diff__variant"
              data-active={impl === "ddb"}
              aria-hidden={impl !== "ddb"}
            >
              {seg.ddb.map((line, j) => (
                <CodeLine key={j} text={line} kind="ddb" />
              ))}
            </div>
            <div
              className="eff-diff__variant"
              data-active={impl === "d1"}
              aria-hidden={impl !== "d1"}
            >
              {seg.d1.map((line, j) => (
                <CodeLine key={j} text={line} kind="d1" />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CodeLine({
  text,
  kind,
}: {
  text: string;
  kind: "common" | "ddb" | "d1";
}) {
  const html = highlightTS(text) || "&nbsp;";
  return (
    <div className={`eff-diff__line eff-diff__line--${kind}`}>
      <span className="eff-diff__marker" aria-hidden />
      <span
        className="eff-diff__content"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/* ───────────────────────── Reusable building blocks ───────────────────────── */

function FeatureRow({
  icon,
  label,
  sub,
  delay = 0,
}: {
  icon: string;
  label: string;
  sub: string;
  delay?: number;
}) {
  return (
    <div
      className="eff-showcase__feature"
      style={{ animationDelay: `${delay}ms` }}
    >
      <Icon
        icon={icon}
        width={22}
        height={22}
        aria-hidden
        className="eff-showcase__feature-icon"
      />
      <div className="eff-showcase__feature-text">
        <div className="eff-showcase__feature-label">{label}</div>
        <div className="eff-showcase__feature-sub">{sub}</div>
      </div>
    </div>
  );
}

function FlowNode({
  icon,
  label,
  sub,
  accent,
  delay = 0,
}: {
  icon: string;
  label: string;
  sub: string;
  accent?: boolean;
  delay?: number;
}) {
  return (
    <div
      className={`eff-showcase__node${accent ? " eff-showcase__node--accent" : ""}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <Icon icon={icon} width={22} height={22} aria-hidden />
      <div className="eff-showcase__node-label">{label}</div>
      <div className="eff-showcase__node-sub">{sub}</div>
    </div>
  );
}

function FlowEdge({ label, delay = 0 }: { label: string; delay?: number }) {
  return (
    <div
      className="eff-showcase__edge"
      data-label={label}
      style={{ animationDelay: `${delay}ms` }}
      aria-hidden
    />
  );
}
