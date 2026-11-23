import type {
  ModelSelection,
  OrchestrationV2ThreadShell,
  ServerProvider,
} from "@t3tools/contracts";

import { BUNDLED_MODEL_MANIFEST } from "../provider/ModelManifest.ts";

export interface ProviderDimensions {
  readonly provider: string;
  readonly model?: string;
}

/**
 * Anonymous provider and model for a model selection. Instance ids are
 * user-defined, so only the driver kind is reported. The model is reported
 * only when the selected instance's vendor catalog lists it.
 */
export function providerDimensions(
  providers: ReadonlyArray<ServerProvider>,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): ProviderDimensions {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (provider === undefined) return { provider: "unknown" };
  const model = vendorCatalogEntry(provider, [selection.model]);
  return model === undefined
    ? { provider: provider.driver }
    : { provider: provider.driver, model: model.slug };
}

const DATED_SNAPSHOT = /-\d{8}$/u;

// The bundled manifest is reviewed in this repo. Vendor catalogs ship models before it does.
const MANIFEST_LABELS: ReadonlyMap<string, string> = new Map(
  Object.values(BUNDLED_MODEL_MANIFEST.providers ?? {}).flatMap((catalog) =>
    catalog.models.flatMap((model) =>
      [model.slug, ...(model.aliases ?? [])].map((name) => [name, model.slug] as const),
    ),
  ),
);

// Drivers whose model lists come from the vendor. OpenCode, Pi, and ACP agents list the
// user's own configuration, such as local Ollama tags. Codex and Claude also list
// early-access code names, so only slugs in the vendor's public family vouch for them.
const VENDOR_CATALOGS: ReadonlyMap<string, RegExp | undefined> = new Map([
  ["cursor", undefined],
  ["grok", undefined],
  ["antigravity", undefined],
  ["codex", /^gpt-/u],
  ["claudeAgent", /^claude-/u],
]);

// A custom endpoint or gateway serves whatever names its owner chose.
const isVendorRouted = (auth: ServerProvider["auth"]) =>
  auth.endpoint === undefined && auth.type !== "customEndpoint" && auth.type !== "bedrock";

function vendorCatalogEntry(provider: ServerProvider, candidates: ReadonlyArray<string>) {
  if (!VENDOR_CATALOGS.has(provider.driver) || !isVendorRouted(provider.auth)) return undefined;
  const family = VENDOR_CATALOGS.get(provider.driver);
  return provider.models.find(
    (entry) =>
      !entry.isCustom &&
      (family === undefined || family.test(entry.slug)) &&
      (candidates.includes(entry.slug) ||
        entry.aliases?.some((alias) => candidates.includes(alias)) === true),
  );
}

/**
 * The vendor catalog slug that a native or routed model id names, such as
 * `anthropic/claude-opus-5-5` or a dated snapshot. Models outside the bundled
 * manifest and vendor-routed provider catalogs, including user-added ones and
 * names a custom endpoint serves, return undefined.
 */
export function catalogModelLabel(
  providers: ReadonlyArray<ServerProvider>,
  model: string,
): string | undefined {
  const leaf = model.slice(model.lastIndexOf("/") + 1);
  const candidates = [model, leaf, leaf.replace(DATED_SNAPSHOT, "")];
  for (const candidate of candidates) {
    const label = MANIFEST_LABELS.get(candidate);
    if (label !== undefined) return label;
  }
  for (const provider of providers) {
    const match = vendorCatalogEntry(provider, candidates);
    if (match !== undefined) return match.slug;
  }
  return undefined;
}

/** The thread fields agent analytics reads. Ids are used for lookups, never reported. */
export type AgentThread = Pick<
  OrchestrationV2ThreadShell,
  "modelSelection" | "runtimeMode" | "interactionMode" | "createdBy" | "creationSource" | "lineage"
>;

type Fields = Readonly<Record<string, unknown>>;

const asFields = (value: unknown): Fields =>
  typeof value === "object" && value !== null ? (value as Fields) : {};

const stringField = (fields: Fields, key: string) =>
  typeof fields[key] === "string" ? (fields[key] as string) : undefined;

/** A string from the tool input only when it is one of the schema's literals. */
const oneOf = (value: string | undefined, allowed: ReadonlyArray<string>) =>
  value !== undefined && allowed.includes(value) ? value : undefined;

/**
 * Whether two resolved providers differ. Unresolved selections compare as
 * unknown rather than as a cross-provider handoff.
 */
export const crossProvider = (caller: string, target: string) =>
  caller === "unknown" || target === "unknown" ? undefined : caller !== target;

const defined = (entries: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));

/**
 * How deep a thread sits in a delegation tree: 0 for a top-level thread, 1 for
 * its subagent, and so on. Forks are top-level threads of their own. Depth is
 * counted by walking parents, capped so a corrupt lineage cannot loop.
 */
export const MAX_REPORTED_DEPTH = 5;

/**
 * Who started the work that made this call. Scheduled runs keep the task
 * creator's provenance, so the run's message marks them instead.
 */
function callerOrigin(input: {
  readonly thread: Pick<AgentThread, "createdBy">;
  readonly scheduledRun: boolean;
}) {
  if (input.scheduledRun) return "scheduler";
  if (input.thread.createdBy === "agent") return "agent";
  return input.thread.createdBy === "system" ? "system" : "user";
}

/**
 * Settings for a handoff, recorded only as closed enums and booleans derived
 * from the tool's arguments and result. Prompts, titles, and ids are never
 * recorded.
 */
export function handoffSettings(tool: string, args: unknown, result: unknown): Fields {
  const input = asFields(args);
  const output = asFields(result);
  switch (tool) {
    case "delegate_task":
      return defined({
        targetChosen: input.target !== undefined,
        // Rejected calls are recorded too, so input strings must match a literal.
        mode: oneOf(stringField(input, "mode"), ["async", "wait"]) ?? "async",
        ...(output.waitTimedOut === true ? { waitTimedOut: true } : {}),
      });
    case "create_threads": {
      const threads = Array.isArray(input.threads) ? input.threads : [];
      return {
        batchSize: threads.length,
        targetChosen: threads.some((thread) => asFields(thread).target !== undefined),
      };
    }
    case "t3_thread_launch":
      return defined({
        targetChosen: input.modelSelection !== undefined,
        workspace:
          input.scratch === true
            ? "scratch"
            : (oneOf(stringField(asFields(input.workspaceStrategy), "type"), [
                "root",
                "worktree",
                "existing_worktree",
              ]) ?? "root"),
      });
    case "t3_thread_send":
      return defined({ delivery: stringField(output, "delivery") });
    case "t3_thread_send_attachments":
      return { delivery: "auto" };
    case "schedule_task": {
      // Omitting the input lets the server decide, so read the saved task.
      const bound = output.boundThreadId;
      return bound === null || typeof bound === "string"
        ? { bindToCurrentThread: bound !== null }
        : {};
    }
    default:
      return {};
  }
}

/** Outcome of a tool call, with the stable failure code when the call failed. */
export function toolOutcome(
  result:
    | { readonly isError?: boolean | undefined; readonly structuredContent?: unknown }
    | undefined,
) {
  if (result === undefined) return { outcome: "error", errorCode: "exception" };
  const content = asFields(result.structuredContent);
  // T3 tool failures are declared errors whose structured content carries a
  // closed `code`; the MCP layer does not always set isError for them.
  const code = stringField(content, "code") ?? stringField(asFields(content.error), "_tag");
  if (result.isError === true || (content._tag !== undefined && code !== undefined)) {
    return { outcome: "error", errorCode: code ?? "unknown" };
  }
  return { outcome: "ok" };
}

/**
 * Event properties for an agent tool call: the calling agent, and when the call
 * handed work to other threads, the agents running them. Each target counts
 * once, so a create_threads batch on two providers reports both.
 */
export function agentToolProperties(input: {
  readonly tool: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly caller: AgentThread | undefined;
  readonly callerProviderInstanceId?: ModelSelection["instanceId"];
  readonly callerDepth?: number;
  readonly callerScheduledRun?: boolean;
  readonly targets: ReadonlyArray<AgentThread>;
  readonly outcome: Fields;
  readonly settings?: Fields;
  readonly durationMs?: number;
}): ReadonlyArray<Readonly<Record<string, unknown>>> {
  const caller =
    input.caller !== undefined
      ? providerDimensions(input.providers, input.caller.modelSelection)
      : input.callerProviderInstanceId !== undefined
        ? {
            provider: providerDimensions(input.providers, {
              instanceId: input.callerProviderInstanceId,
              model: "",
            }).provider,
          }
        : { provider: "unknown" };
  const base = defined({
    tool: input.tool,
    callerProvider: caller.provider,
    callerModel: caller.model,
    callerOrigin:
      input.caller === undefined
        ? undefined
        : callerOrigin({
            thread: input.caller,
            scheduledRun: input.callerScheduledRun === true,
          }),
    callerDepth:
      input.callerDepth === undefined ? undefined : Math.min(input.callerDepth, MAX_REPORTED_DEPTH),
    durationMs: input.durationMs,
    ...input.outcome,
    ...input.settings,
  });
  if (input.targets.length === 0) return [base];
  return input.targets.map((thread) => {
    const target = providerDimensions(input.providers, thread.modelSelection);
    return defined({
      ...base,
      targetProvider: target.provider,
      targetModel: target.model,
      targetRuntimeMode: thread.runtimeMode,
      targetInteractionMode: thread.interactionMode,
      crossProvider: crossProvider(caller.provider, target.provider),
    });
  });
}
