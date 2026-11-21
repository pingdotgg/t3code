import type { PluginAuthoringGuide, PluginAuthoringGuideInput } from "@t3tools/contracts";
import type { PluginServiceDefinition } from "./PluginKernel.ts";

const THREADS = "t3/orchestration-v2/ThreadManagementService";
const PROJECTION = "t3/orchestration-v2/ProjectionStore/ProjectionStoreV2";

const threadServer = (id: string) => `import { createHash } from "node:crypto";
export function activate(host) {
  const { Effect, Schema } = host;
  class SideThreadError extends Schema.TaggedError()("SideThreadError", {
    message: Schema.String, threadId: Schema.String,
  }) {}
  host.services.register(${JSON.stringify(id + ".Threads")}, ({ services }) => {
    const sideId = (source, previous = "") => ${JSON.stringify(id + "-side-")} +
      createHash("sha256").update(JSON.stringify([source, previous])).digest("hex");
    return {
      ensure: ({ threadId: sourceThreadId }) => Effect.gen(function* () {
        // Resolve builtin services when called; plugin activation can precede their startup.
        const projection = services.get(${JSON.stringify(PROJECTION)});
        const threads = services.get(${JSON.stringify(THREADS)});
        const read = id => projection.getThread(id).pipe(
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }));
        const source = yield* read(sourceThreadId);
        if (!source || source.deletedAt !== null) return yield* new SideThreadError({ message: "Source thread is unavailable", threadId: sourceThreadId });
        let threadId = sideId(sourceThreadId);
        let existing = yield* read(threadId);
        while (existing && existing.deletedAt !== null) {
          threadId = sideId(sourceThreadId, threadId);
          existing = yield* read(threadId);
        }
        if (existing && existing.projectId !== source.projectId) return yield* new SideThreadError({ message: "Side thread belongs to another project", threadId });
        if (!existing) yield* threads.dispatch({
          type: "thread.create", commandId: ${JSON.stringify(id + ":create:")} + threadId,
          threadId, projectId: source.projectId, title: "Side: " + source.title,
          modelSelection: source.modelSelection, runtimeMode: source.runtimeMode,
          interactionMode: source.interactionMode, branch: source.branch,
          worktreePath: source.worktreePath, createdBy: "user", creationSource: "web",
        });
        return { threadId, sourceThreadId };
      }),
    };
  });
  host.commands.register("ensure", {
    input: Schema.Struct({ threadId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256), Schema.makeFilter(value => value.trim() === value || "Expected a trimmed thread id")) }),
    output: Schema.Struct({ threadId: Schema.String, sourceThreadId: Schema.String }),
    run: input => host.services.get(${JSON.stringify(id + ".Threads")}).ensure(input),
  });
}
`;

const threadWeb = `import { useEffect, useReducer, useState } from "react";
import { Schema } from "effect";
import { ThreadId } from "@t3tools/plugin-sdk/contracts";
import type { PluginPanelProps, WebPluginHost } from "@t3tools/plugin-sdk/web";

const SideThread = Schema.Struct({ threadId: ThreadId, sourceThreadId: ThreadId });

export function activate(host: WebPluginHost) {
  function Panel({ threadRef }: PluginPanelProps) {
    const [side, setSide] = useState<typeof SideThread.Type | null>(null);
    const [error, setError] = useState("");
    const [revision, retry] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
      let active = true;
      setSide(null); setError("");
      void host.invoke("ensure", { threadId: threadRef.threadId }).then(value => {
        const result = Schema.decodeUnknownSync(SideThread)(value);
        if (active) setSide(result);
      }).catch(cause => { if (active) setError(String(cause)); });
      return () => { active = false; };
    }, [threadRef.threadId, revision]);
    if (error) return <div role="alert">{error}
      <host.ui.Button variant="ghost" size="compact" onClick={retry}>Retry</host.ui.Button>
    </div>;
    if (!side) return <div role="status">Opening side thread...</div>;
    return <host.ui.chat.Thread
      threadRef={{ environmentId: host.environmentId, threadId: side.threadId }}
      contextThreadRef={threadRef}
    />;
  }
  host.panels.register([{ id: "side", title: "Side thread", component: Panel }]);
  host.actions.register([{
    id: "side", title: "Open side thread", slashCommand: "side", requiresThread: true,
    run: ({ threadRef }) => { if (threadRef) host.panels.open(threadRef, "side"); },
  }]);
}
`;

const bannerWeb = `import type { ComposerBannerContributionProps, WebPluginHost } from "@t3tools/plugin-sdk/web";

export function activate(host: WebPluginHost) {
  function Banner({ threadRef }: ComposerBannerContributionProps) {
    if (!threadRef) return null;
    return <host.ui.chat.BannerStack items={[{
      id: "thread-context", variant: "info", icon: null,
      title: "Thread context", description: threadRef.threadId,
    }]} />;
  }
  host.register([{ slot: "chat.composer.banners", id: "thread-context", component: Banner }]);
}
`;

const timerWeb = `import { useEffect, useRef } from "react";
import type { WebPluginHost } from "@t3tools/plugin-sdk/web";

export function activate(host: WebPluginHost) {
  function Timer({ createdAt }: { createdAt: string }) {
    const ref = useRef<HTMLSpanElement>(null);
    useEffect(() => {
      const update = () => {
        const started = Date.parse(createdAt);
        const seconds = Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0;
        if (ref.current) ref.current.textContent = Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
      };
      update();
      const interval = setInterval(update, 1000);
      return () => clearInterval(interval);
    }, [createdAt]);
    return <span ref={ref} className="tabular-nums" />;
  }
  host.register([{
    slot: "component:components/chat/TimelineWorkGroupRows/WorkingTimer", component: Timer,
  }]);
}
`;

const featureWeb = `import type { WebPluginHost } from "@t3tools/plugin-sdk/web";

type RowProps = Record<string, unknown>;
export function activate(host: WebPluginHost) {
  const slot = "component:components/chat/WorkLog/WorkLogRow";
  const Original = host.builtin<RowProps>(slot);
  function Row(props: RowProps) { return <Original {...props} />; }
  host.register([{ slot, component: Row }]);
}
`;

const recipeDefinitions = [
  {
    topic: "thread-panel",
    purpose:
      "A normal durable side thread with native model, effort, speed, permissions, history and attachments.",
    permissions: ["ui", "actions", "server:services"],
    notes: [
      "The starter creates an empty thread in the source workspace without running setup scripts or starting a turn.",
      "Later opens preserve the side thread's own settings and history. Every send attaches the source through contextThreadRef.",
      "Choose a distinct slash command if /side is already registered; builtin and provider command names take precedence.",
    ],
  },
  {
    topic: "composer-banner",
    purpose: "An inline notice above the normal composer, additive across plugins.",
    permissions: ["ui"],
    notes: [
      "Register a unique contribution id at chat.composer.banners. It receives {environmentId, threadRef}; drafts have threadRef:null.",
      "Use host.ui.chat.BannerStack with native item fields: id, variant, icon, title, optional description, actions, children and onDismiss.",
      "Read actual data through host.invoke or existing services. Keep hooks inside your contribution component. Do not replace chat.composer to add a banner.",
    ],
  },
  {
    topic: "working-timer",
    purpose:
      "Change the elapsed-time display while retaining the working row's setup, compaction and background-work behavior.",
    permissions: ["ui"],
    notes: [
      "Replace only component:components/chat/TimelineWorkGroupRows/WorkingTimer, which receives {createdAt:string}.",
      "The starter formats real elapsed time as minutes:seconds and cleans up its one-second timer. Customize this narrow renderer before replacing the whole timeline.",
    ],
  },
  {
    topic: "feature",
    purpose:
      "Customize one existing renderer while preserving its props, children, callbacks and accessibility.",
    permissions: ["ui"],
    notes: [
      "host.builtin(slot) returns the original renderer. host.features() discovers loaded client slots; route and panel chunks may not yet be loaded.",
      "A registration without an id replaces the default. Default replacements select the last contribution; they do not form a wrapper chain.",
      "Use unique ids for additive content. Use native primitive variants/sizes and parent layout; keep existing control actions unless the user asks to change them.",
      "The starter preserves WorkLogRow exactly. Apply only the requested prop or child transformation; do not recreate its controls.",
    ],
  },
  {
    topic: "service",
    purpose: "Change application behavior through the existing Effect service boundary.",
    permissions: ["server:services"],
    notes: [
      "The services field below is the live server kernel catalog, including actual keys, enabled state and members. Inspect the owning service's contract before changing arguments or results.",
      "Use host.services.wrap(key, member, (args, next) => ...) to compose behavior across WebSocket, MCP, HTTP and background callers. Return the same Effect, Stream, Promise or value contract.",
      "For new behavior, register a namespaced service and expose a thin schema-validated command. Use the supplied host.Effect, host.Schema and host.Stream.",
      "Client services use client:services and host.services.list/get. Client-wide services require client:host-services and host.services.host. Desktop services require desktop:services.",
      "host.commands.wrap requires server:commands and intercepts supported unary WebSocket calls only; it is not the service replacement path.",
      "host.events.on(filter, handler) requires server:events and subscribes to committed orchestration events after activation. Filters accept eventType and threadId. Delivery is sequential per subscription; handler errors log and continue, bounded overflow stops the subscription, and disposal stops delivery.",
    ],
  },
  {
    topic: "provider",
    purpose:
      "Add or wrap an agent runtime; ordinary conversation plugins use the native thread's provider picker.",
    permissions: ["server:providers"],
    notes: [
      "Register a ProviderDriver with host.providers.register during activation. It declares driverKind, metadata, configSchema, defaultConfig and create. host.providers.getBuiltin(kind) returns an existing driver to compose around.",
      "create receives {instanceId, displayName, accentColor, environment, enabled, config}. Its scoped instance must preserve continuationIdentity, snapshot, orchestrationAdapter and textGeneration plus supported optional capabilities. Inspect the driver and adapter contracts before implementing a new protocol.",
      "Use scoped create factories, preserve native capabilities and protocol contracts, and release owned processes/resources with the scope.",
      "Configure an instance in this environment's settings.json providerInstances. Its driver config must satisfy its schema; configured instances then appear in normal settings and model selection.",
    ],
  },
] as const;

/** Returned by the running host, so installed agents do not need a repository checkout. */
export function createPluginAuthoringGuide(
  input: PluginAuthoringGuideInput,
  pluginDirectory: string,
  services: ReadonlyArray<PluginServiceDefinition>,
): PluginAuthoringGuide {
  const topic = input.topic ?? "overview";
  const id = input.id ?? "local.my-plugin";
  const selected = recipeDefinitions.filter(
    (recipe) => topic === "overview" || recipe.topic === topic,
  );
  return {
    apiVersion: 1,
    pluginDirectory,
    workflow: [
      "Inspect the requested reference in the real app and preserve its existing controls, data and actions.",
      "Choose a recipe, then call plugins_authoring_guide with its topic and your plugin id. UI and thread recipes include ready-to-save files; service/provider recipes require inspecting the owning contract before implementation.",
      "Write files under pluginDirectory/<manifest-id>. New plugins start disabled; enable through plugins_set_enabled after preparing the requested local code.",
      "Edits hot reload automatically. Use plugins_reload as an explicit retry; inspect plugins_list and the real client for activation errors.",
      "Exercise real data and the actual provider/client path. Check composition with other plugins, close/reopen, disable and reload. Report unsupported surfaces honestly.",
    ],
    rules: [
      "Default to existing host UI and services. Treat explicit user requests for a different design or behavior as permission to customize or replace the needed pieces.",
      "For a T3 conversation use host.ui.chat.Thread with threadRef. Use controlled Composer/Timeline only when an external service intentionally owns its transport and history.",
      "Compose in the narrowest slot that achieves the request. Preserve unrelated behavior, callbacks, keyboard actions, accessibility, loading/error states and provider selection.",
      "Write web/server source in JS, TS, JSX or TSX. The host compiles the captured graph before activation; web JSX and normal react imports use the client's own React instance.",
      "Use @t3tools/plugin-sdk for definePlugin and import type from /web, /server, /native or /desktop for the process host. /contracts exposes host-owned identifier and manifest schemas. TypeScript compilation erases types; editor typechecks use the SDK package.",
      "Supported Effect source imports are effect plus effect/Context, effect/Effect, effect/Layer, effect/Option, effect/Schema, effect/Scope and effect/Stream. Bundle other dependencies first or vendor code with relative imports inside the captured directory; host node_modules, arbitrary bare packages, Vite paths and symlinks are unavailable.",
      "Keep the captured package within 2,000 files and 16 MiB. Compilation has a 10-second deadline and 16 MiB input/output limits. Import code or JSON; register CSS with host.style instead of importing CSS.",
      "Register contributions during activate(host). Return cleanup or use host.onDispose for listeners/resources. Invalid edits retain the last working generation; disable removes the plugin's contributions.",
      "Web recipes run in web and desktop. Mobile uses native declarative primitives or Metro-bundled modules; web React code is not a mobile implementation.",
      "Permissions control host API registration, not isolation of in-process server code. Write to this environment's pluginDirectory, not another T3 home's live state.",
    ],
    components: [
      {
        api: "host.ui.chat.Thread",
        purpose:
          "Full app thread: {threadRef, contextThreadRef?}; owns model controls, composer, timeline, usage and normal turn dispatch.",
      },
      {
        api: "host.ui.chat.BannerStack / Banner",
        purpose:
          "Actual composer notice stack and primitives; contribute at chat.composer.banners.",
      },
      {
        api: "host.ui.Button / Menu / MenuTrigger / MenuPopup / MenuItem",
        purpose: "Native controls with existing variants, sizes, keyboard behavior and animations.",
      },
      {
        api: "host.ui.chat.Topbar / Breadcrumb / Composer / Timeline",
        purpose:
          "Shared controlled building blocks for intentionally custom layouts or external transports.",
      },
      {
        api: "host.builtin(slot) / host.features()",
        purpose:
          "Original app renderers and loaded client feature discovery, including WorkLog, WorkingTimer, markdown, diff, file preview, browser, settings and usage.",
      },
    ],
    recipes: selected.map((recipe) => {
      const files: PluginAuthoringGuide["recipes"][number]["files"][number][] = [];
      if (topic !== "overview") {
        const web =
          recipe.topic === "thread-panel"
            ? threadWeb
            : recipe.topic === "composer-banner"
              ? bannerWeb
              : recipe.topic === "working-timer"
                ? timerWeb
                : recipe.topic === "feature"
                  ? featureWeb
                  : undefined;
        if (web !== undefined) {
          const entries =
            recipe.topic === "thread-panel"
              ? { web: "web.tsx", server: "server.mjs" }
              : { web: "web.tsx" };
          files.push({
            path: "plugin.json",
            content:
              JSON.stringify(
                {
                  id,
                  apiVersion: 1,
                  name: id,
                  version: "1.0.0",
                  permissions: recipe.permissions,
                  entries,
                },
                null,
                2,
              ) + "\n",
          });
          files.push({ path: "web.tsx", content: web });
          if (recipe.topic === "thread-panel")
            files.push({ path: "server.mjs", content: threadServer(id) });
        }
      }
      return { ...recipe, files };
    }),
    services: services.filter(
      (service) =>
        topic === "service" ||
        (["overview", "thread-panel", "composer-banner"].includes(topic) &&
          [THREADS, PROJECTION].includes(service.key)),
    ),
  };
}
