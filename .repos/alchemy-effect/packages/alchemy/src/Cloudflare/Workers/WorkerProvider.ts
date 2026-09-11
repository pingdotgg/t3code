import * as durableObjectsApi from "@distilled.cloud/cloudflare/durable-objects";
import * as rulesets from "@distilled.cloud/cloudflare/rulesets";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as wfp from "@distilled.cloud/cloudflare/workers-for-platforms";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isHttpClientError } from "effect/unstable/http/HttpClientError";
import * as crypto from "node:crypto";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Artifacts from "../../Artifacts.ts";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { hashDirectory, type MemoOptions } from "../../Command/Memo.ts";
import { havePropsChanged, isResolved, stripEffects } from "../../Diff.ts";
import * as ProviderLayer from "../../Local/ProviderLayer.ts";
import * as Provider from "../../Provider.ts";
import { type ResourceBinding } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { cachedFunction } from "../../Util/cached-function.ts";
import { initialCwd } from "../../Util/Node.ts";
import { sha256Object } from "../../Util/sha256.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { localRuntimeServices } from "../LocalRuntime.ts";
import { detachQueueConsumersOfScript } from "../Queues/Consumer.ts";
import { CloudflareLogs } from "../Logs.ts";
import {
  resolveZoneId,
  type Reference as ZoneReference,
} from "../Zone/lookup.ts";
import {
  getAssetsPathPrefix,
  mergeAssetsConfigFiles,
  readAssets,
  readAssetsConfigFiles,
  uploadAssets,
} from "./Assets.ts";
import { getCompatibility } from "./Compatibility.ts";
import { isDurableObjectExport } from "./DurableObject.ts";
import { LocalWorkerProvider } from "./LocalWorkerProvider.ts";
import { makeSourceContext, resolveSource } from "./Source.ts";
import {
  isSelfUrl,
  Worker,
  type ViteOptions,
  type WorkerProps,
  type WorkerRouteConfig,
  type WorkerVersionAffinity,
} from "./Worker.ts";
import {
  getCacheBinding,
  getCronBindings,
  isContainerDecl,
} from "./WorkerAsyncBindings.ts";
import type {
  WireWorkerBinding,
  WorkerBinding,
  WorkerSettingsBinding,
} from "./WorkerBinding.ts";
import { readPrebuiltWorkerBundle } from "./Sources/Prebuilt.ts";
import { isPythonMain, readPythonWorkerBundle } from "./Sources/Python.ts";
import { WorkerBundle } from "./Sources/Rolldown.ts";
import { isWorkerLoader } from "./WorkerLoader.ts";
import { createWorkerName } from "./WorkerName.ts";
class MissingDurableObjects extends Data.TaggedError("MissingDurableObjects")<{
  scriptName: string;
  expected: string[];
}> {}

/**
 * A Durable Object class is being dropped from this Worker while a binding in
 * the same deploy still references it on another script — the class moved
 * cross-script, but its namespace (and every stored object in it) still lives
 * on this Worker. Cloudflare rejects a single upload that both deletes the
 * class and ships a binding referencing it, and silently deleting would
 * destroy the namespace's data irreversibly, so the deploy fails before any
 * upload.
 *
 * Moving a Durable Object class between Workers is always declared: set
 * `transferredFrom` on the Durable Object at its **new host** — naming the
 * former host by Worker logical id (same stack) or physical script name — and
 * Alchemy performs the data-preserving `transferred_classes` migration on the
 * new host's deploy; this deploy then converges on its own. To abandon the
 * data instead, remove the binding entirely in one deploy (which deletes the
 * class and its data), then add the cross-script binding in a second deploy.
 */
export class DurableObjectTransferRequired extends Data.TaggedError(
  "DurableObjectTransferRequired",
)<{
  scriptName: string;
  className: string;
  targetScriptName: string | undefined;
}> {
  override get message() {
    return (
      `Durable Object class '${this.className}' still lives on Worker '${this.scriptName}' but this deploy re-binds it as a cross-script reference` +
      (this.targetScriptName ? ` to '${this.targetScriptName}'` : "") +
      ". Durable Object data does NOT move with the class automatically. " +
      `To move the data, set transferredFrom: "${this.scriptName}" (the former host's script name, or its Worker logical id for same-stack moves) on the Durable Object declaration in its new host Worker. ` +
      "To abandon the data, remove the binding entirely in one deploy before re-adding it as a cross-script reference."
    );
  }
}

/**
 * More than one script matches the `transferredFrom` declaration of a Durable
 * Object (e.g. an orphaned script left behind by a `name` prop change still
 * carries the same alchemy tags, or the host history lists several scripts
 * that each still hold a same-class namespace). Alchemy refuses to guess
 * which namespace's data to move — narrow the declaration to the exact
 * physical script name that holds the data.
 */
export class AmbiguousDurableObjectTransfer extends Data.TaggedError(
  "AmbiguousDurableObjectTransfer",
)<{
  scriptName: string;
  logicalId: string;
  className: string;
  sources: string[];
}> {
  override get message() {
    return (
      `Durable Object '${this.logicalId}' (class '${this.className}') is new to Worker '${this.scriptName}' and multiple scripts match its transferredFrom declaration: ${this.sources.join(", ")}. ` +
      `Narrow transferredFrom to the exact physical script name that holds the data.`
    );
  }
}

/**
 * Resolve the Workers for Platforms dispatch-namespace *name* from a resolved
 * `namespace` prop or persisted attribute. The engine resolves a passed
 * {@link DispatchNamespace} resource to its Attributes object (see
 * `Input.Resolve` / Plan.ts), so the value is either the namespace name
 * string, that attributes object, or `undefined` for a regular Worker.
 *
 * @internal
 */
export const resolveNamespaceName = (
  namespace: unknown,
): string | undefined => {
  if (namespace == null) return undefined;
  if (typeof namespace === "string") return namespace;
  return (namespace as { name?: string }).name;
};

/**
 * Resolve a Worker's `tailConsumers` / `streamingTailConsumers` prop into
 * the wire-shape consumer list
 * (`[{ service }]`). The engine resolves a passed {@link Worker} to its
 * Attributes object — possibly stables-only during planning, but
 * `workerName` is always a stable — so each entry is either a script-name
 * string or that attributes object. Whole-resource entries are reduced to
 * the script name alone so hashing/diffing never sees the consumer's
 * per-deploy fields (`hash`, `url`, ...), mirroring
 * {@link resolveVersionParentName}.
 *
 * An empty array resolves to `[]` (explicitly detach every consumer);
 * `undefined`/absent resolves to `undefined`.
 *
 * This is also the seam for local emulation: the local provider lowers this
 * same resolved list into workerd's `Worker.tails` / `Worker.streamingTails`
 * service designators (`RuntimeWorker.tails` / `RuntimeWorker.streamingTails`).
 *
 * @internal
 */
export const resolveTailConsumers = (
  tailConsumers: WorkerProps["tailConsumers" | "streamingTailConsumers"],
): { service: string }[] | undefined => {
  if (tailConsumers == null) return undefined;
  return tailConsumers.flatMap((consumer) => {
    const service =
      typeof consumer === "string"
        ? consumer
        : (consumer as { workerName?: unknown }).workerName;
    return typeof service === "string" ? [{ service }] : [];
  });
};

/**
 * A Worker's `version` configuration is invalid — a prop that can't be
 * combined with `version.parent` (script-level settings belong to the
 * parent), a locally-hosted Durable Object / Workflow class on a version
 * worker, an out-of-range `traffic`, or a gradual rollout that requires
 * changes the versions API can't carry (assets, DO migrations).
 */
export class WorkerVersionConfigError extends Data.TaggedError(
  "WorkerVersionConfigError",
)<{
  message: string;
}> {}

/**
 * Resolve the parent script *name* from a resolved `version.parent` prop or
 * persisted props. The engine resolves a passed {@link Worker} (or
 * `Worker.ref(...)`) to its Attributes object — possibly stables-only during
 * planning, but `workerName` is always a stable — so the value is either the
 * script name string, that attributes object, or `undefined`.
 *
 * @internal
 */
export const resolveVersionParentName = (
  version: WorkerProps["version"],
): string | undefined => {
  const parent = version?.parent;
  if (parent == null) return undefined;
  if (typeof parent === "string") return parent;
  const workerName = (parent as { workerName?: unknown }).workerName;
  return typeof workerName === "string" ? workerName : undefined;
};

/**
 * The traffic percentage a *self-owned* Worker's new version should receive,
 * or `undefined` for the default full cutover. Only a `version` prop without
 * a `parent` participates — version workers handle traffic separately.
 *
 * @internal
 */
const getSelfRolloutTraffic = (news: WorkerProps): number | undefined => {
  if (!news.version || news.version.parent != null) return undefined;
  const traffic = news.version.traffic;
  return traffic === undefined || traffic >= 100 ? undefined : traffic;
};

const validateTraffic = (traffic: number | undefined) =>
  traffic !== undefined &&
  (!Number.isFinite(traffic) || traffic < 0 || traffic > 100)
    ? Effect.fail(
        new WorkerVersionConfigError({
          message: `version.traffic must be a percentage between 0 and 100, got ${traffic}`,
        }),
      )
    : Effect.void;

/** The request header Cloudflare hashes to pin a request to a version. */
const AFFINITY_HEADER = "Cloudflare-Workers-Version-Key";

/**
 * `version.affinity` normalized to a single key source plus the optional
 * IP fallback.
 *
 * @internal exported for unit testing.
 */
export interface ResolvedVersionAffinity {
  source:
    | { kind: "cookie" | "header"; name: string }
    | { kind: "ip" }
    | { kind: "key"; expression: string };
  ipFallback: boolean;
}

// Cookie / header names are interpolated into a double-quoted Rules-language
// string literal — restrict them to the token characters real-world names
// use so a name can never terminate the literal or smuggle expression text.
const AFFINITY_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Validate `version.affinity` and normalize it to its key source: exactly
 * one of `cookie` / `header` / `key`, or `ip: true` alone; `ip` combines
 * with `cookie` / `header` as the absent-source fallback.
 *
 * @internal exported for unit testing.
 */
export const resolveVersionAffinity = (
  affinity: WorkerVersionAffinity,
): Effect.Effect<ResolvedVersionAffinity, WorkerVersionConfigError> =>
  Effect.gen(function* () {
    const declared = [
      ...(affinity.cookie !== undefined ? ["cookie"] : []),
      ...(affinity.header !== undefined ? ["header"] : []),
      ...(affinity.key !== undefined ? ["key"] : []),
    ];
    if (declared.length > 1) {
      return yield* Effect.fail(
        new WorkerVersionConfigError({
          message: `version.affinity accepts exactly one key source, got ${declared.join(" and ")}. Combine sources with a raw \`key\` expression instead.`,
        }),
      );
    }
    if (declared.length === 0 && affinity.ip !== true) {
      return yield* Effect.fail(
        new WorkerVersionConfigError({
          message:
            "version.affinity requires a key source: set `cookie`, `header`, `key`, or `ip: true`.",
        }),
      );
    }
    if (affinity.key !== undefined && affinity.ip === true) {
      return yield* Effect.fail(
        new WorkerVersionConfigError({
          message:
            "version.affinity: `ip` is the fallback for an absent `cookie`/`header` — a raw `key` expression has no absence condition to fall back from. Fold `ip.src` into the expression instead.",
        }),
      );
    }
    for (const [prop, name] of [
      ["cookie", affinity.cookie],
      ["header", affinity.header],
    ] as const) {
      if (name !== undefined && !AFFINITY_NAME_PATTERN.test(name)) {
        return yield* Effect.fail(
          new WorkerVersionConfigError({
            message: `version.affinity.${prop} '${name}' is not a valid ${prop} name: expected only letters, digits, '_', '.', and '-'.`,
          }),
        );
      }
    }
    const source: ResolvedVersionAffinity["source"] =
      affinity.cookie !== undefined
        ? { kind: "cookie", name: affinity.cookie }
        : affinity.header !== undefined
          ? // Rules-language header map keys are lowercase.
            { kind: "header", name: affinity.header.toLowerCase() }
          : affinity.key !== undefined
            ? { kind: "key", expression: affinity.key }
            : { kind: "ip" };
    return {
      source,
      ipFallback:
        affinity.ip === true &&
        (source.kind === "cookie" || source.kind === "header"),
    };
  });

/** A hostname a Worker serves on within one zone. */
interface AffinityZoneHost {
  host: string;
  /** `true` when `host` came from a route pattern containing `*`. */
  wildcard: boolean;
}

/**
 * The `http.host` clause scoping a zone's affinity rules to the Worker's
 * own hostnames, so unrelated zone traffic — and other Workers' rollouts
 * on the same zone — never get this Worker's version key.
 *
 * @internal exported for unit testing.
 */
export const affinityHostExpression = (
  hosts: readonly AffinityZoneHost[],
): string => {
  const dedupe = (values: string[]) => [...new Set(values)].sort();
  const exact = dedupe(hosts.filter((h) => !h.wildcard).map((h) => h.host));
  const wild = dedupe(hosts.filter((h) => h.wildcard).map((h) => h.host));
  const clauses = [
    ...(exact.length === 1
      ? [`http.host eq "${exact[0]}"`]
      : exact.length > 1
        ? [`http.host in {${exact.map((h) => `"${h}"`).join(" ")}}`]
        : []),
    ...wild.map((h) => `http.host wildcard "${h}"`),
  ];
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" or ")})`;
};

interface AffinityRuleSpec {
  description: string;
  expression: string;
  /** Rules-language expression producing the header value. */
  value: string;
}

const affinityRulePrefix = (scriptName: string) =>
  `alchemy:worker:${scriptName}:affinity`;

/**
 * The transform rules pinning one zone's traffic: a primary rule filling
 * the version-key header from the configured source, plus — for
 * `cookie`/`header` sources with `ip: true` — a fallback rule keying
 * requests that lack the source by client IP.
 *
 * @internal exported for unit testing.
 */
export const buildAffinityZoneRules = (
  scriptName: string,
  affinity: ResolvedVersionAffinity,
  hosts: readonly AffinityZoneHost[],
): AffinityRuleSpec[] => {
  const prefix = affinityRulePrefix(scriptName);
  const hostExpr = affinityHostExpression(hosts);
  const { source } = affinity;
  if (source.kind === "ip" || source.kind === "key") {
    return [
      {
        description: `${prefix}:key`,
        expression: hostExpr,
        value: source.kind === "ip" ? "to_string(ip.src)" : source.expression,
      },
    ];
  }
  const field =
    source.kind === "cookie"
      ? `http.request.cookies["${source.name}"]`
      : `http.request.headers["${source.name}"]`;
  return [
    {
      description: `${prefix}:key`,
      expression: `${hostExpr} and len(${field}) > 0`,
      value: `${field}[0]`,
    },
    ...(affinity.ipFallback
      ? [
          {
            // An absent cookie/header is a *missing* value in the Rules
            // language, and every comparison on missing evaluates false —
            // `len(field) == 0` can never match. `not (len(field) > 0)`
            // is the complement that does: missing → false → `not` → true.
            description: `${prefix}:ip`,
            expression: `${hostExpr} and not (len(${field}) > 0)`,
            value: "to_string(ip.src)",
          },
        ]
      : []),
  ];
};

/**
 * A Worker's `domain` configuration is invalid — a hostname appears in more
 * than one role (name/aliases/redirects), or a redirect targets itself.
 */
export class WorkerDomainConfigError extends Data.TaggedError(
  "WorkerDomainConfigError",
)<{
  message: string;
}> {}

/**
 * The resolved shape of `WorkerProps.workersDev`: `enabled` drives the
 * stable `<name>.<account>.workers.dev` URL, `previewsEnabled` the
 * per-version preview URLs. The two toggles are independent on the
 * Cloudflare API.
 *
 * @internal exported for unit testing.
 */
export interface ResolvedWorkersDev {
  enabled: boolean;
  previewsEnabled: boolean;
}

/**
 * Resolve the `workersDev` prop to its full shape. `true` / omitted means
 * "default workers.dev behavior" (stable URL + version previews), `false`
 * disables both, and the object form fills unset toggles with `true`.
 *
 * @internal exported for unit testing.
 */
export const resolveWorkersDev = (
  workersDev: WorkerProps["workersDev"],
): ResolvedWorkersDev => {
  if (workersDev === undefined || workersDev === true) {
    return { enabled: true, previewsEnabled: true };
  }
  if (workersDev === false) {
    return { enabled: false, previewsEnabled: false };
  }
  return {
    enabled: workersDev.enabled ?? true,
    previewsEnabled: workersDev.previewsEnabled ?? true,
  };
};

/**
 * The resolved shape of `WorkerProps.domain`: the canonical hostname plus
 * alias and redirect hostname lists, all punycode-normalized and
 * de-duplicated.
 *
 * @internal exported for unit testing.
 */
export interface ResolvedWorkerDomain {
  name: string;
  aliases: string[];
  redirects: string[];
  /** Pinned zone from props, when the caller set zoneId / zone / zoneName. */
  zone?: ZoneReference;
}

const isZoneReference = (value: unknown): value is ZoneReference => {
  if (typeof value === "string") return true;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { zoneId?: unknown; name?: unknown };
  return (
    typeof candidate.zoneId === "string" &&
    (candidate.name === undefined || typeof candidate.name === "string")
  );
};

/** Collapse Worker.domain zone pin fields to one {@link ZoneReference}. */
export const resolveWorkerDomainZone = (
  config:
    | {
        readonly zoneId?: unknown;
        readonly zoneName?: unknown;
        readonly zone?: unknown;
      }
    | undefined,
): ZoneReference | undefined => {
  if (config === undefined) return undefined;
  if (typeof config.zoneId === "string") return config.zoneId;
  if (isZoneReference(config.zone)) return config.zone;
  if (typeof config.zoneName === "string") return config.zoneName;
  return undefined;
};

/** Whether an existing attachment must move to satisfy an explicit zone pin. */
export const shouldRecreateWorkerDomainAttachment = (
  liveZoneId: string,
  desiredZoneId: string | undefined,
): boolean => desiredZoneId !== undefined && liveZoneId !== desiredZoneId;

// After deleting a custom-domain attachment, Cloudflare can briefly retain
// ownership of the hostname and reject the replacement with code 100116.
const workerDomainConflictSchedule = Schedule.max([
  Schedule.spaced("2 seconds"),
  Schedule.recurs(8),
]);

// Convert non-ASCII hostnames (emoji, IDN, etc.) to punycode so the
// Cloudflare API receives the form it stores domains in. `new URL(...)`
// does IDNA via WHATWG URL parsing — `📦.alchemy.run` → `xn--5z8h.alchemy.run`.
const toPunycode = (hostname: string): string => {
  try {
    return new URL(`https://${hostname}`).hostname;
  } catch {
    return hostname;
  }
};

/**
 * Resolve the `domain` prop to its full shape — a bare string is shorthand
 * for `{ name }`. Hostnames are punycode-normalized and de-duplicated;
 * a hostname may only play one role, so aliases/redirects that repeat the
 * canonical name (or each other) fail with a typed error.
 *
 * @internal exported for unit testing.
 */
export const resolveWorkerDomain = (
  // `string[]` is the pre-redesign prop shape — it can still reach us from
  // persisted `olds` written by older providers (read's classification).
  domain: WorkerProps["domain"] | string[],
): Effect.Effect<ResolvedWorkerDomain | undefined, WorkerDomainConfigError> =>
  Effect.gen(function* () {
    if (domain === undefined || domain === null) return undefined;
    // Legacy array form: the first hostname was the primary custom domain
    // (`url = domains[0]` back then), the rest map to aliases. A legacy
    // empty array was the explicit detach-all — no domain.
    const config =
      typeof domain === "string"
        ? { name: domain }
        : Array.isArray(domain)
          ? domain.length > 0
            ? { name: domain[0], aliases: domain.slice(1) }
            : undefined
          : domain;
    if (config === undefined) return undefined;
    const name = toPunycode(config.name);
    const aliases = Array.from(new Set((config.aliases ?? []).map(toPunycode)));
    const redirects = Array.from(
      new Set((config.redirects ?? []).map(toPunycode)),
    );
    const overlap = [
      ...aliases.filter((h) => h === name),
      ...redirects.filter((h) => h === name || aliases.includes(h)),
    ];
    if (overlap.length > 0) {
      return yield* Effect.fail(
        new WorkerDomainConfigError({
          message: `Each hostname may play only one role in a Worker's domain config; ${[...new Set(overlap)].map((h) => `'${h}'`).join(", ")} appears in more than one of name/aliases/redirects.`,
        }),
      );
    }
    const zone = resolveWorkerDomainZone(config);
    return zone === undefined
      ? { name, aliases, redirects }
      : { name, aliases, redirects, zone };
  });

const isWorkersDevHostname = (hostname: string) =>
  hostname.endsWith(".workers.dev");

// Hostnames that only appear in local-dev state (the dev server's
// localhost/LAN URLs), never as attachable custom domains.
const isLocalDevHostname = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "::1" ||
  /^\d+\.\d+\.\d+\.\d+$/.test(hostname);

const urlHostname = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** The `rules` payload shape of a zone phase-entrypoint PUT. */
type PutZoneRedirectRules = rulesets.PutPhasForZoneRequest["rules"];

/**
 * The *custom domain* hostnames recorded in a Worker's persisted legacy
 * `domains` state — minus the workers.dev (stable or preview) and local-dev
 * entries that shared the list in older formats.
 *
 * @internal exported for unit testing.
 */
export const stateCustomDomains = (
  domains: readonly unknown[] | undefined,
): string[] =>
  normalizeStateDomains(domains).filter(
    (hostname) =>
      !isWorkersDevHostname(hostname) && !isLocalDevHostname(hostname),
  );

/**
 * The Worker's persisted domain configuration: the `domain` attribute for
 * state written by the current format, else re-derived from the legacy
 * `domains` list (first custom hostname = canonical name, rest = aliases;
 * legacy state had no redirects).
 *
 * @internal exported for unit testing.
 */
export const stateWorkerDomain = (
  output: object | undefined,
): ResolvedWorkerDomain | undefined => {
  const state = output as
    | {
        domain?: {
          name?: unknown;
          aliases?: unknown[];
          redirects?: unknown[];
          zone?: ZoneReference;
          zoneId?: unknown;
          zoneName?: unknown;
        } | null;
        domains?: unknown[];
      }
    | undefined;
  const domain = state?.domain;
  if (domain && typeof domain.name === "string") {
    const zone = resolveWorkerDomainZone(domain);
    return {
      name: domain.name,
      aliases: (domain.aliases ?? []).filter(
        (h): h is string => typeof h === "string",
      ),
      redirects: (domain.redirects ?? []).filter(
        (h): h is string => typeof h === "string",
      ),
      ...(zone === undefined ? {} : { zone }),
    };
  }
  const legacy = stateCustomDomains(state?.domains);
  return legacy.length > 0
    ? { name: legacy[0], aliases: legacy.slice(1), redirects: [] }
    : undefined;
};

// Workers for Platforms "user workers" live inside a dispatch namespace and
// use a parallel family of script endpoints (`/workers/dispatch/namespaces/
// :namespace/scripts/...`). The request/response shapes are identical to the
// account-level Workers API for everything the provider touches, so these
// helpers route by `dispatchNamespace` and the call sites stay agnostic.

/**
 * Read a script's combined settings, routing to the dispatch-namespace
 * endpoint when `dispatchNamespace` is set. The two response shapes are
 * structurally identical for the fields the provider consumes (`bindings`,
 * `tags`, `logpush`), so the WFP response is surfaced as the workers shape.
 *
 * @internal
 */
const getScriptSettings = (
  accountId: string,
  scriptName: string,
  dispatchNamespace: string | undefined,
) =>
  // `Effect.gen` (rather than a ternary) so the two branches unify into a
  // single `Effect<Settings, WorkersErr | WfpErr>` instead of a *union* of
  // Effects, which `.pipe`/`catchTag` at the call sites can't consume.
  Effect.gen(function* () {
    if (dispatchNamespace) {
      const settings = yield* wfp.getDispatchNamespaceScriptSetting({
        accountId,
        dispatchNamespace,
        scriptName,
      });
      // The dispatch-namespace settings response is structurally identical to
      // the account-level one for the fields the provider reads.
      return settings as unknown as workers.GetScriptScriptAndVersionSettingResponse;
    }
    return yield* workers.getScriptScriptAndVersionSetting({
      accountId,
      scriptName,
    });
  });

/**
 * Deploy-time binding validation rejects an upload whose bindings
 * reference a resource Cloudflare can't see (each resource type has
 * its own typed not-found error, verified against the live API).
 * Every bound resource is provisioned before the Worker deploys —
 * dependency order for KV/R2/D1/queues/etc., a pre-created stub
 * (which exports the Durable Object classes) for circular
 * Worker↔Worker references — so a not-found here is either
 * propagation lag on a just-created resource (a Secrets Store secret
 * still `pending`, a stub script not yet in the registry) that
 * retrying converges, or a genuine misconfiguration that keeps
 * failing and surfaces as the typed error once the bounded budget is
 * exhausted.
 */
const isBindingTargetNotFound = (
  e:
    | Effect.Error<ReturnType<typeof workers.putScript>>
    | Effect.Error<ReturnType<typeof wfp.putDispatchNamespaceScript>>
    | Effect.Error<ReturnType<typeof workers.createScriptVersion>>,
): boolean =>
  e._tag === "SecretsStoreBindingNotFound" ||
  e._tag === "KVNamespaceNotFound" ||
  e._tag === "R2BucketNotFound" ||
  e._tag === "D1DatabaseNotFound" ||
  e._tag === "QueueNotFound" ||
  e._tag === "ServiceBindingNotFound" ||
  e._tag === "DurableObjectClassNotFound" ||
  e._tag === "HyperdriveConfigNotFound" ||
  e._tag === "VectorizeIndexNotFound" ||
  e._tag === "DispatchNamespaceNotFound" ||
  e._tag === "MtlsCertificateNotFound";

const bindingTargetNotFoundRetrySchedule = () =>
  Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(10)]);

/**
 * Script PUT is an idempotent upsert, so a pure transport failure (the
 * request died before any response — e.g. Cloudflare closing a keep-alive
 * socket that idled while slow upstream resources provisioned earlier in the
 * deploy) is safe to replay. Errors that carry a response are real API
 * verdicts and are NOT retried here.
 */
const isScriptPutTransportError = (e: { _tag?: string }): boolean =>
  isHttpClientError(e) && e.reason._tag === "TransportError";

const retryableScriptPut = (
  e: Parameters<typeof isBindingTargetNotFound>[0],
): boolean => isBindingTargetNotFound(e) || isScriptPutTransportError(e);

/**
 * Upsert a Worker script, routing to the dispatch-namespace endpoint when
 * `dispatchNamespace` is set. The metadata/files contract is identical, and
 * both endpoints run the same binding validation (see
 * {@link isBindingTargetNotFound}), so both get the same bounded retry.
 *
 * @internal
 */
/**
 * A cached `workerId` attribute usable as the immutable script ID — rules
 * out the legacy shape (older releases persisted the script *name*), the
 * `dev:`-marked local identity, and the precreate stub's provisional `""`.
 */
const cachedWorkerId = (
  value: string | undefined,
  scriptName: string,
): string | undefined =>
  value !== undefined &&
  value !== "" &&
  value !== scriptName &&
  !value.startsWith("dev:")
    ? value
    : undefined;

export class WorkerIdNotFound extends Data.TaggedError("WorkerIdNotFound")<{
  scriptName: string;
  message: string;
}> {}

/**
 * Resolve a script's immutable Worker ID (carried as `tag` on Cloudflare's
 * wire) by script name. Neither the settings endpoints nor GET /content
 * expose it, so scan the account's script listing lazily and stop at the
 * first match. The listing is eventually consistent, so a missing entry is
 * retried briefly before failing.
 */
const findWorkerId = (accountId: string, scriptName: string) =>
  workers.listScripts.items({ accountId }).pipe(
    Stream.filter((script) => script.id === scriptName),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
    Effect.flatMap((script) =>
      script?.tag != null
        ? Effect.succeed(script.tag)
        : Effect.fail(
            new WorkerIdNotFound({
              scriptName,
              message: `Cloudflare Worker: could not resolve the immutable ID of script '${scriptName}' from the account listing`,
            }),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "WorkerIdNotFound",
      schedule: Schedule.max([Schedule.spaced(2000), Schedule.recurs(3)]),
    }),
  );

const putWorkerScript = (params: {
  accountId: string;
  scriptName: string;
  dispatchNamespace: string | undefined;
  metadata: workers.PutScriptRequest["metadata"];
  files: workers.PutScriptRequest["files"];
}) =>
  Effect.gen(function* () {
    if (params.dispatchNamespace) {
      return yield* wfp
        .putDispatchNamespaceScript({
          accountId: params.accountId,
          dispatchNamespace: params.dispatchNamespace,
          scriptName: params.scriptName,
          metadata:
            params.metadata as unknown as wfp.PutDispatchNamespaceScriptRequest["metadata"],
          files: params.files,
        })
        .pipe(
          Effect.retry({
            while: retryableScriptPut,
            schedule: bindingTargetNotFoundRetrySchedule(),
          }),
        );
    }
    return yield* workers
      .putScript({
        accountId: params.accountId,
        scriptName: params.scriptName,
        metadata: params.metadata,
        files: params.files,
      })
      .pipe(
        Effect.retry({
          while: retryableScriptPut,
          schedule: bindingTargetNotFoundRetrySchedule(),
        }),
      );
  });

/**
 * Delete a Worker script, routing to the dispatch-namespace endpoint when
 * `dispatchNamespace` is set.
 *
 * @internal
 */
const deleteWorkerScript = (
  accountId: string,
  scriptName: string,
  dispatchNamespace: string | undefined,
) =>
  Effect.gen(function* () {
    if (dispatchNamespace) {
      return yield* wfp.deleteDispatchNamespaceScript({
        accountId,
        dispatchNamespace,
        scriptName,
        force: true,
      });
    }
    return yield* workers
      .deleteScript({ accountId, scriptName, force: true })
      .pipe(
        // The script is still registered as a queue consumer (even with
        // `force`). Normally the sibling Consumer resource detaches first,
        // but state loss (e.g. a consumer row rewritten by a pre-stamping
        // dev run) can strand a live consumer pointing at this script with
        // nothing left to delete it. The script is going away, so any
        // consumer wiring pointing at it is dead — detach and retry.
        Effect.catchTag("QueueConsumerConflict", () =>
          detachQueueConsumersOfScript(accountId, scriptName).pipe(
            Effect.andThen(
              workers.deleteScript({ accountId, scriptName, force: true }),
            ),
          ),
        ),
      );
  });

/**
 * Normalize a Worker's persisted *legacy* `domains` state to bare
 * hostnames. Alchemy <= beta.44 stored each custom domain as a
 * `{ id, hostname, zoneId }` object; beta.45+ stored `https://<hostname>`
 * URL strings (with the workers.dev URL mixed in); current state stores the
 * `domain` config object instead of a `domains` list. All legacy
 * generations coerce to hostnames so the diff never throws on older state
 * (#546). Entries that fit no generation are dropped rather than turned
 * into a bogus hostname that would skew the diff.
 *
 * @internal exported for unit testing.
 */
export const normalizeStateDomains = (
  domains: readonly unknown[] | undefined,
): string[] =>
  (domains ?? []).flatMap((u) => {
    if (typeof u === "string") {
      if (u.includes("://")) {
        try {
          return [new URL(u).hostname];
        } catch {
          return [];
        }
      }
      return u.length > 0 ? [u] : [];
    }
    const hostname = (u as { hostname?: unknown } | null)?.hostname;
    return typeof hostname === "string" ? [hostname] : [];
  });

/**
 * Custom domains Alchemy is responsible for on this Worker — either declared
 * on props (`domain`) or already persisted as non-`workers.dev` URLs in state.
 * Used by `read` to skip `listDomains` when the surface is unmanaged (#926).
 *
 * @internal exported for unit testing.
 */
export const shouldObserveWorkerDomains = (
  olds: Pick<WorkerProps, "domain"> | undefined,
  output: object | undefined,
): boolean =>
  olds?.domain !== undefined || stateWorkerDomain(output) !== undefined;

/**
 * Zone routes Alchemy is responsible for on this Worker. Used by `read` to
 * skip account-wide zone/route fan-out when the surface is unmanaged (#926).
 *
 * @internal exported for unit testing.
 */
export const shouldObserveWorkerRoutes = (
  olds: Pick<WorkerProps, "routes"> | undefined,
  output: Pick<Worker["Attributes"], "routes"> | undefined,
): boolean => olds?.routes !== undefined || (output?.routes?.length ?? 0) > 0;

/**
 * Cron triggers Alchemy is responsible for on this Worker. Used by `read` to
 * skip `getScriptSchedule` when the surface is unmanaged (#926). Effect-native
 * `cron()` bindings persist into `output.crons` after the first reconcile, so
 * subsequent reads still observe them.
 *
 * @internal exported for unit testing.
 */
export const shouldObserveWorkerCrons = (
  olds: Pick<WorkerProps, "crons"> | undefined,
  output: Pick<Worker["Attributes"], "crons"> | undefined,
): boolean => olds?.crons !== undefined || (output?.crons?.length ?? 0) > 0;

/**
 * Optional override for the account's stable `workers.dev` subdomain
 * (`<subdomain>` in `https://<script>.<subdomain>.workers.dev`). When set,
 * Worker URL construction skips `GET /accounts/{id}/workers/subdomain`.
 */
const CLOUDFLARE_WORKERS_SUBDOMAIN = Config.string(
  "CLOUDFLARE_WORKERS_SUBDOMAIN",
).pipe(
  Config.map((value) => value.trim()),
  Config.option,
);

const WORKERS_SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Max concurrent `GET /zones/{id}/workers/routes` calls when observing the
 * routes attached to a Worker. Route listing is per-zone, so this fans out
 * with the number of zones the Worker has routes in; unbounded fan-out here
 * is what trips Cloudflare account-level 429 / code 971 throttling (#926).
 */
const WORKER_ROUTE_LIST_CONCURRENCY = 8;

type MetadataHashValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly MetadataHashValue[]
  | { readonly [key: string]: MetadataHashValue };

/**
 * Deeply materialize an arbitrary value into a JSON-stable shape for hashing:
 * unwrap `Redacted` secrets by value, ISO-stringify `Date`s, keep plain
 * objects/arrays/primitives, and drop Effects, functions, `undefined`, and
 * class instances (which don't round-trip through `JSON.stringify`). Redacted
 * values contribute by value, not by reference identity, so two
 * independently-constructed secrets with the same contents hash identically.
 *
 * Effects are dropped, never executed: evaluating one here may require
 * plan-phase context that is not available inside lifecycle operations.
 */
const resolveMetadataHashValue = (
  value: unknown,
): Effect.Effect<MetadataHashValue> =>
  Effect.gen(function* () {
    if (Effect.isEffect(value)) {
      return undefined;
    }
    const resolved = Redacted.isRedacted(value) ? Redacted.value(value) : value;

    if (
      resolved === null ||
      Predicate.isString(resolved) ||
      Predicate.isNumber(resolved) ||
      Predicate.isBoolean(resolved)
    ) {
      return resolved;
    }
    if (resolved === undefined || Predicate.isFunction(resolved)) {
      return undefined;
    }
    if (Predicate.isDate(resolved)) {
      return resolved.toISOString();
    }
    if (Array.isArray(resolved)) {
      return yield* Effect.all(
        resolved.map((item) => resolveMetadataHashValue(item)),
        { concurrency: "unbounded" },
      );
    }
    if (Predicate.isObject(resolved)) {
      // Only plain objects round-trip predictably. A class instance would
      // serialize to `{}` (or throw), so drop it rather than hash a lie.
      const prototype = Object.getPrototypeOf(resolved);
      if (prototype !== Object.prototype && prototype !== null) {
        return undefined;
      }
      const entries = yield* Effect.all(
        Object.entries(resolved).map(([key, nested]) =>
          resolveMetadataHashValue(nested).pipe(
            Effect.map(
              (materializedNested) => [key, materializedNested] as const,
            ),
          ),
        ),
        { concurrency: "unbounded" },
      );
      return Object.fromEntries(
        entries.filter(([, nested]) => nested !== undefined),
      );
    }
    return undefined;
  });

/**
 * The deploy-time metadata surface of a Worker whose changes must trigger an
 * update but that never touch the bundle/vite/asset-content hashes:
 * compatibility, env/bindings, asset routing config, cache, limits, logpush,
 * observability, placement, subdomain, and tags. See #745.
 */
interface WorkerMetadataHashInput {
  readonly props: WorkerProps;
  readonly bindings: readonly ResourceBinding<Worker["Binding"]>[];
  readonly accountId: string;
  readonly stack: { readonly name: string; readonly stage: string };
  /**
   * The resolved URL a `Worker.URL` (`self_url`) binding lowers into.
   * Included in the hash so external URL changes (an account-subdomain
   * rename, a custom-domain reorder) redeploy the Worker with the fresh
   * value even though props and binding data are unchanged.
   */
  readonly selfUrl?: string;
}

// The asset router config the resource declares (htmlHandling,
// notFoundHandling, ...), minus the local `directory` path (machine-specific,
// would break hash stability across machines) and the precomputed `hash`
// (already compared via `output.hash.assets`). A bare string `assets` is just
// a directory path, so it contributes nothing here.
const workerAssetConfigForHash = (assets: WorkerProps["assets"]) => {
  if (!assets || typeof assets === "string") {
    return undefined;
  }
  const { directory: _directory, ...config } = assets;
  if (Predicate.hasProperty(config, "hash")) {
    const { hash: _hash, ...configWithoutHash } = config;
    return configWithoutHash;
  }
  return config;
};

/**
 * Hash a Worker's deploy-time metadata surface so metadata-only edits are
 * detected by the diff (#745). Previously the update decision compared only
 * the bundle/vite/asset-content hashes, so a change to e.g. a compatibility
 * flag or observability config planned as a noop and silently never deployed.
 */
const resolveWorkerMetadataHash = ({
  props,
  bindings,
  accountId,
  stack,
  selfUrl,
}: WorkerMetadataHashInput): Effect.Effect<string> =>
  resolveMetadataHashValue({
    accountId,
    selfUrl,
    stack: { name: stack.name, stage: stack.stage },
    compatibility: getCompatibility(props),
    // Every `env` entry is lowered into binding data by
    // `bindWorkerAsyncBindings`, including literals and VITE_ values. Hash only
    // that canonical wire representation. Resource-backed env values can be
    // materialized as different attribute projections between reconcile and a
    // later plan; hashing props.env as well would turn those irrelevant shape
    // differences into perpetual updates.
    bindings: bindings.map((binding) => ({
      sid: binding.sid,
      data: binding.data,
    })),
    assets: workerAssetConfigForHash(props.assets),
    cache: props.cache,
    limits: props.limits,
    logpush: props.logpush,
    observability: props.observability,
    placement: props.placement,
    // The source descriptor is plain JSON data; hashing it means
    // switching providers (or changing provider options) triggers an
    // update even when no hash slot the new source computes differs.
    source: props.source,
    tags: props.tags,
    // Reduce each consumer to its script name: a referenced Worker's other
    // attributes (hash, url, ...) change on every consumer deploy, which
    // would spuriously re-deploy this producer.
    tailConsumers: resolveTailConsumers(props.tailConsumers),
    streamingTailConsumers: resolveTailConsumers(props.streamingTailConsumers),
    workersDev: resolveWorkersDev(props.workersDev),
    // Reduce `version.parent` to the parent's script name: the resolved
    // parent is a full attributes object whose *other* fields (hash, url,
    // ...) change on every parent deploy, which would spuriously re-version
    // this Worker even though nothing about the version itself changed.
    version: props.version
      ? {
          parent: resolveVersionParentName(props.version),
          traffic: props.version.traffic,
          alias: props.version.alias,
          affinity: props.version.affinity,
          message: props.version.message,
          tag: props.version.tag,
        }
      : undefined,
  }).pipe(Effect.flatMap((metadata) => sha256Object({ metadata })));

export const WorkerProvider = () =>
  ProviderLayer.dual(Worker, {
    live: () => LiveWorkerProvider(),
    // The local runtime deps (workerd, WorkerProxy, LocalRuntimeState)
    // compose INTO the local variant so a live deploy only constructs them
    // if the local provider is actually demanded (e.g. deleting a local
    // dev worker's state row). See ProviderLayer.dual.
    local: () =>
      LocalWorkerProvider().pipe(Layer.provide(localRuntimeServices())),
  });

export const LiveWorkerProvider = () =>
  Provider.effect(
    Worker,
    Effect.gen(function* () {
      const path = yield* Path.Path;

      const bundler = yield* WorkerBundle;
      const stack = yield* Stack;

      // const createScriptSubdomain = yield* workers.createScriptSubdomain;
      // const deleteScript = yield* workers.deleteScript;
      // const getScriptSubdomain = yield* workers.getScriptSubdomain;
      // const getScriptSchedule = yield* workers.getScriptSchedule;
      // const getScriptSettings = yield* workers.getScriptScriptAndVersionSetting;
      // const getSubdomain = yield* workers.getSubdomain;
      // const putScript = yield* workers.putScript;
      // const putScriptSchedule = yield* workers.putScriptSchedule;
      // const putDomain = yield* workers.putDomain;
      // const listDomains = yield* workers.listDomains;
      // const deleteDomain = yield* workers.deleteDomain;
      // const listZones = yield* zones.listZones;
      const telemetry = yield* CloudflareLogs;

      // Account subdomain is invariant for the life of a provider layer —
      // memoize so N Workers (or repeated plan/deploy reads) don't each hit
      // GET /accounts/{id}/workers/subdomain and trip Cloudflare's 429/971
      // throttle (#926). `CLOUDFLARE_WORKERS_SUBDOMAIN` bypasses the lookup
      // entirely when the operator already knows the value.
      const getAccountSubdomain = yield* cachedFunction((accountId: string) =>
        Effect.gen(function* () {
          const configured = yield* CLOUDFLARE_WORKERS_SUBDOMAIN;
          if (Option.isSome(configured) && configured.value !== "") {
            if (!WORKERS_SUBDOMAIN_PATTERN.test(configured.value)) {
              return yield* Effect.die(
                new Error(
                  `Invalid CLOUDFLARE_WORKERS_SUBDOMAIN "${configured.value}": ` +
                    "expected a workers.dev subdomain label (lowercase letters, digits, hyphens)",
                ),
              );
            }
            return configured.value;
          }
          const result = yield* workers.getSubdomain({ accountId });
          return result.subdomain;
        }),
      );

      // Converge the script's workers.dev settings via `POST /subdomain`.
      // The two toggles are independent on the Cloudflare API: `enabled`
      // drives the stable `<name>.<account>.workers.dev` URL and
      // `previews_enabled` the per-version preview URLs.
      const setWorkerSubdomain = Effect.fn(function* (
        name: string,
        desired: ResolvedWorkersDev,
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        return yield* workers.createScriptSubdomain({
          accountId,
          scriptName: name,
          enabled: desired.enabled,
          previewsEnabled: desired.previewsEnabled,
        });
      });

      const normalizeCrons = (crons: string[] | undefined): string[] =>
        Array.from(new Set(crons ?? []));

      const hasSelfUrlBinding = (
        bindings: readonly ResourceBinding<Worker["Binding"]>[],
      ) =>
        bindings.some((b) =>
          (b.data.bindings ?? []).some((item) => item.type === "self_url"),
        );

      // Resolve the URL this Worker will be served at — the same formula that
      // produces the `url` attribute (first custom domain in user order, else
      // the workers.dev URL) — usable BEFORE the script upload, so `Worker.URL`
      // bindings can be lowered into plain_text bindings and VITE_*-prefixed
      // env entries can be inlined into the client bundle at build time.
      const resolveSelfUrl = Effect.fn(function* (
        name: string,
        props: WorkerProps,
        accountId: string,
      ) {
        const domain = yield* resolveWorkerDomain(props.domain);
        if (domain) {
          return `https://${domain.name}`;
        }
        if (!resolveWorkersDev(props.workersDev).enabled) {
          return yield* Effect.die(
            `Worker "${name}" binds its own URL (Worker.URL) but has none: the stable workers.dev URL is disabled (workersDev) and no custom domain is configured.`,
          );
        }
        return `https://${name}.${yield* getAccountSubdomain(accountId)}.workers.dev`;
      });

      const getWorkerCrons = Effect.fn(function* (scriptName: string) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        return yield* workers
          .getScriptSchedule({
            accountId,
            scriptName,
          })
          .pipe(
            Effect.map((response) =>
              normalizeCrons(
                response.schedules.map((schedule) => schedule.cron),
              ),
            ),
            Effect.catchTag("WorkerNotFound", () => Effect.succeed([])),
          );
      });

      const reconcileCrons = (
        scriptName: string,
        desired: string[],
        previous: string[],
        session: ScopedPlanStatusSession,
      ) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const live = yield* getWorkerCrons(scriptName);
          const desiredSorted = [...desired].sort();
          const liveSorted = [...live].sort();
          const changed =
            desiredSorted.length !== liveSorted.length ||
            desiredSorted.some((cron, index) => cron !== liveSorted[index]);

          if (!changed) return live;

          if (desired.length > 0 || previous.length > 0 || live.length > 0) {
            yield* session.note(
              `Reconciling Cron Triggers (${desired.length}) ...`,
            );
          }

          const result = yield* workers
            .putScriptSchedule({
              accountId,
              scriptName,
              body: desired.map((cron) => ({ cron })),
            })
            .pipe(
              Effect.retry({
                while: (error) => error._tag === "WorkerNotFound",
                schedule: Schedule.max([
                  Schedule.exponential(200),
                  Schedule.recurs(15),
                ]),
              }),
            );
          return normalizeCrons(
            result.schedules.map((schedule) => schedule.cron),
          );
        });

      /**
       * Resolve a hostname to a Cloudflare zone id. An explicit pin
       * (`zoneId` / zone name / `{ zoneId }`) wins. Otherwise look the
       * hostname up with {@link resolveZoneId} (`GET /zones?name=` per
       * parent label) — never by listing the account's first page of zones.
       */
      const inferZoneIdForHostname = (
        hostname: string,
        zoneCache: Map<string, string>,
        zone?: ZoneReference,
      ) =>
        Effect.gen(function* () {
          const cacheKey =
            zone === undefined
              ? hostname
              : `${hostname}:${typeof zone === "string" ? zone : zone.zoneId}`;
          const cached = zoneCache.get(cacheKey);
          if (cached) return cached;
          const { accountId } = yield* yield* CloudflareEnvironment;
          const zoneId = yield* resolveZoneId({ accountId, zone, hostname });
          zoneCache.set(cacheKey, zoneId);
          return zoneId;
        });

      const reconcileDomains = (
        scriptName: string,
        desired: string[],
        zone?: ZoneReference,
      ) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          // Always query the live state of domains attached to *this*
          // Worker rather than trusting `_previous` from local state.
          // State may have been wiped, populated by another machine, or
          // simply be out of date. Without this we PUT domains that are
          // already registered to this same Worker and Cloudflare
          // returns a confusing "hostname already in use" error.
          const liveAll = yield* workers
            .listDomains({
              accountId,
              service: scriptName,
            })
            .pipe(
              Effect.map((r) =>
                (r.result ?? []).flatMap((d) =>
                  d.id && d.hostname && d.zoneId
                    ? [
                        {
                          id: d.id,
                          hostname: d.hostname,
                          zoneId: d.zoneId,
                          service: d.service ?? undefined,
                        },
                      ]
                    : [],
                ),
              ),
              Effect.catch(() => Effect.succeed([])),
            );

          const desiredSet = new Set(desired);
          const liveByHostname = new Map(liveAll.map((d) => [d.hostname, d]));

          // Detach what's no longer wanted. Use the live list so we
          // don't try to delete domains we no longer track.
          const toRemove = liveAll.filter((d) => !desiredSet.has(d.hostname));
          yield* Effect.all(
            toRemove.map((d) =>
              workers
                .deleteDomain({ accountId, domainId: d.id })
                .pipe(Effect.catchTag("DomainNotFound", () => Effect.void)),
            ),
            { concurrency: "unbounded" },
          );

          if (desired.length === 0) return [];

          const zoneCache = new Map<string, string>();

          // Attach `hostname` to this Worker. Skip the PUT entirely if
          // the hostname is already attached to *this* Worker — that's a
          // no-op for Cloudflare and avoids the "already in use" 409.
          // If it's attached to a *different* Worker, refuse with a
          // clear message rather than silently re-routing traffic.
          const attachDomain = Effect.fn(function* (hostname: string) {
            const live = liveByHostname.get(hostname);
            const desiredZoneId =
              zone === undefined
                ? undefined
                : yield* inferZoneIdForHostname(hostname, zoneCache, zone);
            if (
              live &&
              !shouldRecreateWorkerDomainAttachment(live.zoneId, desiredZoneId)
            ) {
              return {
                hostname: live.hostname,
                id: live.id,
                zoneId: live.zoneId,
              };
            }

            if (live) {
              // Cloudflare cannot change the zone of an existing custom
              // domain in place. Delete only this still-desired attachment,
              // then recreate it below with the explicitly requested zone.
              yield* workers
                .deleteDomain({ accountId, domainId: live.id })
                .pipe(Effect.catchTag("DomainNotFound", () => Effect.void));
            }

            // Not attached to this Worker — but it could still belong
            // to another Worker. Check before we try to PUT so we can
            // emit a helpful error instead of the raw 409.
            const otherOwner = yield* workers
              .listDomains({
                accountId,
                hostname,
              })
              .pipe(
                Effect.map((r) =>
                  (r.result ?? []).find(
                    (d) => d.hostname === hostname && d.service !== scriptName,
                  ),
                ),
                Effect.catch(() => Effect.succeed(undefined)),
              );
            if (otherOwner?.id) {
              return yield* Effect.die(
                new Error(
                  `Cannot attach hostname '${hostname}' to Worker '${scriptName}': ` +
                    `it is already attached to Worker '${otherOwner.service ?? "<unknown>"}'. ` +
                    `Detach it from that Worker first, or pick a different hostname.`,
                ),
              );
            }

            const zoneId =
              desiredZoneId ??
              (yield* inferZoneIdForHostname(hostname, zoneCache));
            // Same eventual-consistency window as `setWorkerSubdomain`:
            // PUT /accounts/.../workers/domains right after `putScript`
            // can return `WorkerNotFound` until Cloudflare's script
            // registry has propagated. Retry on that specific tag.
            const res = yield* workers
              .putDomain({
                accountId,
                hostname,
                service: scriptName,
                zoneId,
              })
              .pipe(
                Effect.retry({
                  while: (error) => error._tag === "WorkerNotFound",
                  schedule: Schedule.max([
                    Schedule.exponential(200),
                    Schedule.recurs(15),
                  ]),
                }),
                Effect.retry({
                  while: (error) => error._tag === "HostnameAlreadyInUse",
                  schedule: workerDomainConflictSchedule,
                }),
              );
            return {
              hostname,
              id: res.id ?? "",
              zoneId: res.zoneId ?? zoneId,
            };
          });

          const applied = yield* Effect.all(desired.map(attachDomain), {
            concurrency: "unbounded",
          });
          return applied;
        });

      // The preview URL of the Worker's *current* version:
      // `https://<version-prefix>-<name>.<subdomain>.workers.dev`, where the
      // prefix is the first 8 characters of the version id (read from the
      // latest deployment's majority version). Resolves to `undefined` when
      // no deployment is visible yet — callers treat the preview URL as
      // best-effort. Only consulted in previews-only mode
      // (`workersDev: { enabled: false, previewsEnabled: true }`), where it
      // is the Worker's only workers.dev surface.
      const getPreviewUrl = Effect.fn(function* (
        scriptName: string,
        accountSubdomain: string,
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const deployments = yield* workers
          .listScriptDeployments({ accountId, scriptName })
          .pipe(
            Effect.map((response) => response.deployments ?? []),
            Effect.catch(() => Effect.succeed([])),
          );
        const latest = [...deployments].sort((a, b) =>
          b.createdOn.localeCompare(a.createdOn),
        )[0];
        const version = latest?.versions?.reduce(
          (max, candidate) =>
            max === undefined || candidate.percentage > max.percentage
              ? candidate
              : max,
          undefined as { percentage: number; versionId: string } | undefined,
        );
        if (!version?.versionId) return undefined;
        return `https://${version.versionId.slice(0, 8)}-${scriptName}.${accountSubdomain}.workers.dev`;
      });

      /**
       * Assemble every URL a deployed, script-owning Worker serves at, most
       * significant first — the first entry becomes the `url` attribute:
       *
       * 1. `https://<domain.name>` — the canonical custom domain
       * 2. aliases, in declared order
       * 3. the stable workers.dev URL (`workersDev.enabled`)
       * 4. preview URLs of the version this deploy uploaded (gradual
       *    rollouts), or — in previews-only mode — the current version's
       *    preview URL, which is then the only workers.dev surface
       *
       * Redirect hostnames never appear: they don't serve the Worker.
       * (Version workers don't use this — their `urls` are their preview
       * URLs, assembled in `putWorkerVersion`.)
       */
      const computeWorkerUrls = Effect.fn(function* (params: {
        scriptName: string;
        workersDev: ResolvedWorkersDev;
        domain: ResolvedWorkerDomain | undefined;
        /** the version uploaded by this deploy (self-rollout), if any */
        uploadedVersionId?: string;
        /** user-provided `version.alias` attached to the uploaded version */
        uploadedVersionAlias?: string;
      }) {
        const { workersDev, domain, scriptName } = params;
        const urls: string[] = [];
        if (domain) {
          urls.push(
            `https://${domain.name}`,
            ...domain.aliases.map((hostname) => `https://${hostname}`),
          );
        }
        if (workersDev.enabled || workersDev.previewsEnabled) {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const accountSubdomain = yield* getAccountSubdomain(accountId);
          if (workersDev.enabled) {
            urls.push(`https://${scriptName}.${accountSubdomain}.workers.dev`);
          }
          if (workersDev.previewsEnabled) {
            if (params.uploadedVersionId !== undefined) {
              if (params.uploadedVersionAlias !== undefined) {
                urls.push(
                  `https://${params.uploadedVersionAlias}-${scriptName}.${accountSubdomain}.workers.dev`,
                );
              }
              urls.push(
                `https://${params.uploadedVersionId.split("-")[0]}-${scriptName}.${accountSubdomain}.workers.dev`,
              );
            } else if (!workersDev.enabled) {
              const previewUrl = yield* getPreviewUrl(
                scriptName,
                accountSubdomain,
              );
              if (previewUrl) urls.push(previewUrl);
            }
          }
        }
        return urls;
      });

      /**
       * Converge the redirect rules for a Worker's `domain.redirects` in
       * each affected zone's `http_request_dynamic_redirect` phase
       * entrypoint. Rules are identified by a
       * `alchemy:worker:<script>:redirect:<host>` description; only our own
       * rules are added/removed — every other rule in the shared entrypoint
       * ruleset passes through untouched. Zones that previously held our
       * rules but no longer should (removed redirects, removed domain) are
       * cleaned the same way.
       */
      const reconcileRedirectRules = Effect.fn(function* (params: {
        scriptName: string;
        domain: ResolvedWorkerDomain | undefined;
        /** hostname → zoneId for every currently-attached custom domain */
        zoneIdByHostname: ReadonlyMap<string, string>;
        /** redirect hostnames from previous state (for zone cleanup) */
        previousRedirects: readonly string[];
      }) {
        const prefix = `alchemy:worker:${params.scriptName}:redirect:`;
        const desired = params.domain?.redirects ?? [];
        const targetName = params.domain?.name;
        // Zones to touch: every zone hosting a desired redirect, plus every
        // zone that hosted one before (so removals converge). Hostnames
        // whose zone we can't resolve (e.g. the domain was already
        // detached) are skipped — their rules become unreachable dead
        // config at worst, never a failed destroy.
        const zoneIds = new Set<string>();
        for (const hostname of [...desired, ...params.previousRedirects]) {
          const zoneId = params.zoneIdByHostname.get(hostname);
          if (zoneId) zoneIds.add(zoneId);
        }
        if (zoneIds.size === 0) return;
        for (const zoneId of zoneIds) {
          const entrypoint = yield* rulesets
            .getPhasForZone({
              zoneId,
              rulesetPhase: "http_request_dynamic_redirect",
            })
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
          const existingRules = entrypoint?.rules ?? [];
          const ourDesired = desired
            .filter(
              (hostname) => params.zoneIdByHostname.get(hostname) === zoneId,
            )
            .map((hostname) => ({
              action: "redirect" as const,
              expression: `http.host eq "${hostname}"`,
              description: `${prefix}${hostname}`,
              enabled: true,
              actionParameters: {
                fromValue: {
                  statusCode: 301,
                  preserveQueryString: true,
                  targetUrl: {
                    expression: `concat("https://${targetName}", http.request.uri.path)`,
                  },
                },
              },
            }));
          const isOurs = (rule: { description?: string | null }) =>
            (rule.description ?? "").startsWith(prefix);
          const ourExisting = existingRules.filter(isOurs);
          const converged =
            ourExisting.length === ourDesired.length &&
            ourDesired.every((rule) =>
              ourExisting.some(
                (existing) =>
                  existing.description === rule.description &&
                  existing.expression === rule.expression,
              ),
            );
          if (converged) continue;
          // Pass foreign rules through untouched (minus the read-only
          // fields the PUT schema doesn't accept) and replace our own set.
          const foreign = existingRules
            .filter((rule) => !isOurs(rule))
            .map((rule) => {
              const {
                lastUpdated: _lastUpdated,
                version: _version,
                ...rest
              } = rule as Record<string, unknown> & {
                lastUpdated?: string;
                version?: string;
              };
              return rest;
            });
          yield* rulesets.putPhasForZone({
            zoneId,
            rulesetPhase: "http_request_dynamic_redirect",
            rules: [...foreign, ...ourDesired] as PutZoneRedirectRules,
          });
        }
      });

      /**
       * Converge the version-affinity transform rules (`version.affinity`)
       * in each serving zone's `http_request_late_transform` phase
       * entrypoint: `rewrite` rules that fill the
       * `Cloudflare-Workers-Version-Key` header from the configured source,
       * scoped to the Worker's hostnames in that zone. Rules are identified
       * by an `alchemy:worker:<script>:affinity` description prefix; only
       * our own rules are added/updated/removed — every other rule in the
       * shared entrypoint passes through untouched. Zones that previously
       * held our rules but no longer should (affinity removed, zone no
       * longer served) are cleaned the same way. Returns the zone ids now
       * holding rules, for persistence in `affinityZoneIds`.
       */
      const reconcileAffinityRules = Effect.fn(function* (params: {
        scriptName: string;
        /** `undefined` removes every rule (affinity removed / delete). */
        desired:
          | {
              affinity: ResolvedVersionAffinity;
              hostsByZone: ReadonlyMap<string, AffinityZoneHost[]>;
            }
          | undefined;
        /** zone ids holding rules per previous state (for cleanup). */
        previousZoneIds: readonly string[];
      }) {
        const prefix = affinityRulePrefix(params.scriptName);
        const zoneIds = new Set([
          ...(params.desired?.hostsByZone.keys() ?? []),
          ...params.previousZoneIds,
        ]);
        for (const zoneId of zoneIds) {
          const hosts = params.desired?.hostsByZone.get(zoneId);
          const ourDesired =
            params.desired !== undefined && hosts !== undefined
              ? buildAffinityZoneRules(
                  params.scriptName,
                  params.desired.affinity,
                  hosts,
                )
              : [];
          const entrypoint = yield* rulesets
            .getPhasForZone({
              zoneId,
              rulesetPhase: "http_request_late_transform",
            })
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
          const existingRules = entrypoint?.rules ?? [];
          const isOurs = (rule: { description?: string | null }) =>
            (rule.description ?? "").startsWith(prefix);
          // The header-value expression of an existing rewrite rule, for
          // convergence comparison. `headers` is an untyped wire record:
          // `{ "<Header-Name>": { operation, expression | value } }`.
          const existingValue = (rule: (typeof existingRules)[number]) => {
            const headers =
              "actionParameters" in rule
                ? (
                    rule.actionParameters as
                      | { headers?: Record<string, unknown> | null }
                      | null
                      | undefined
                  )?.headers
                : undefined;
            const header = headers?.[AFFINITY_HEADER] as
              | { expression?: unknown }
              | undefined;
            return typeof header?.expression === "string"
              ? header.expression
              : undefined;
          };
          const ourExisting = existingRules.filter(isOurs);
          const converged =
            ourExisting.length === ourDesired.length &&
            ourDesired.every((rule) =>
              ourExisting.some(
                (existing) =>
                  existing.description === rule.description &&
                  existing.expression === rule.expression &&
                  existingValue(existing) === rule.value,
              ),
            );
          if (converged) continue;
          // Pass foreign rules through untouched (minus the read-only
          // fields the PUT schema doesn't accept) and replace our own set.
          const foreign = existingRules
            .filter((rule) => !isOurs(rule))
            .map((rule) => {
              const {
                lastUpdated: _lastUpdated,
                version: _version,
                ...rest
              } = rule as Record<string, unknown> & {
                lastUpdated?: string;
                version?: string;
              };
              return rest;
            });
          yield* rulesets.putPhasForZone({
            zoneId,
            rulesetPhase: "http_request_late_transform",
            rules: [
              ...foreign,
              ...ourDesired.map((rule) => ({
                action: "rewrite" as const,
                description: rule.description,
                enabled: true,
                expression: rule.expression,
                actionParameters: {
                  headers: {
                    [AFFINITY_HEADER]: {
                      operation: "set",
                      expression: rule.value,
                    },
                  },
                },
              })),
            ] as PutZoneRedirectRules,
          });
        }
        return [...(params.desired?.hostsByZone.keys() ?? [])].sort();
      });

      type NormalizedWorkerRoute = {
        pattern: string;
        zoneId: string;
      };

      const routeKey = (route: { pattern: string; zoneId: string }) =>
        `${route.zoneId}:${route.pattern}`;

      // Derive a concrete hostname inside the zone from a route pattern so
      // zone inference can walk the DNS label hierarchy. A wildcard label
      // (`*.example.com/*`) is replaced with a stand-in label — only the
      // parent labels matter for finding the zone.
      const hostnameFromPattern = (pattern: string): string => {
        const hostPart = pattern.split("/")[0] ?? pattern;
        return hostPart.startsWith("*.")
          ? `routes.${hostPart.slice(2)}`
          : hostPart;
      };

      // Resolve each route's zone to a concrete zone id: an explicit
      // `zoneId` wins, then `zone` / `zoneName` via `resolveZoneId`, and
      // finally inference from the pattern's hostname. Duplicate
      // `(zoneId, pattern)` pairs are dropped — Cloudflare enforces one
      // route per pattern per zone.
      const normalizeRoutes = (routes: WorkerRouteConfig[] | undefined) =>
        Effect.gen(function* () {
          if (!routes?.length) return [] as NormalizedWorkerRoute[];
          const { accountId } = yield* yield* CloudflareEnvironment;
          const zoneCache = new Map<string, string>();
          const normalized: NormalizedWorkerRoute[] = [];
          const seen = new Set<string>();
          for (const route of routes) {
            const pattern = route.pattern.trim();
            const zoneId = route.zoneId
              ? route.zoneId
              : route.zone || route.zoneName
                ? yield* resolveZoneId({
                    accountId,
                    zone: route.zone ?? route.zoneName!,
                    hostname: hostnameFromPattern(pattern),
                  })
                : yield* inferZoneIdForHostname(
                    hostnameFromPattern(pattern),
                    zoneCache,
                  );
            const key = routeKey({ pattern, zoneId });
            if (seen.has(key)) continue;
            seen.add(key);
            normalized.push({ pattern, zoneId });
          }
          return normalized;
        });

      // List the routes attached to `scriptName` across the given zones.
      // Routes without an id/pattern or owned by another script are
      // ignored. Zones the token can't read are skipped rather than
      // failing the whole listing.
      const listWorkerRoutesInZones = (
        scriptName: string,
        zoneIds: readonly string[],
      ) => {
        const uniqueZoneIds = Array.from(new Set(zoneIds));
        if (uniqueZoneIds.length === 0) {
          return Effect.succeed([] as Worker["Attributes"]["routes"]);
        }

        const routesByZone = Effect.all(
          uniqueZoneIds.map((zoneId) =>
            workers.listRoutes({ zoneId }).pipe(
              Effect.map((response) =>
                (response.result ?? []).flatMap((route) =>
                  route.id && route.pattern && route.script === scriptName
                    ? [{ id: route.id, pattern: route.pattern, zoneId }]
                    : [],
                ),
              ),
              Effect.catch(() => Effect.succeed([])),
            ),
          ),
          // Bounded: this issues one request per zone, so a Worker with routes
          // spread across many zones would otherwise burst the account's whole
          // API budget in a single tick (#926).
          { concurrency: WORKER_ROUTE_LIST_CONCURRENCY },
        );

        return Effect.map(routesByZone, (routes) => routes.flat());
      };

      // Observe the routes attached to `scriptName` in the zones Alchemy
      // already associates with this Worker.
      //
      // This used to enumerate every zone on the account and then list routes
      // in each one. Routes are zone-scoped with no account-level enumeration
      // API, so that costs O(zones) requests on *every* Worker read — on an
      // account with a few hundred zones a couple of plan/deploy cycles
      // exhausts Cloudflare's per-user API budget and unrelated calls start
      // coming back 429 / code 971 (#926).
      //
      // `reconcileRoutes` already scopes itself to the zones implied by
      // `desired ∪ previous` rather than sweeping the account, so `read` now
      // uses the same bounded zone set: the zones of the routes already
      // recorded in state. The blind spot this introduces — a route added out
      // of band in a zone this Worker has never had a route in — is the one
      // `reconcileRoutes` already has.
      const readWorkerRoutes = (
        scriptName: string,
        knownRoutes: Worker["Attributes"]["routes"] | undefined,
      ) =>
        listWorkerRoutesInZones(
          scriptName,
          (knownRoutes ?? []).map((route) => route.zoneId),
        );

      // Converge the zone routes attached to `scriptName` to `desired`.
      // Observed cloud state (not `previous`) is the diff baseline —
      // `previous` only contributes zone ids so routes moved out of a zone
      // are still cleaned up after state loss or an interrupted apply.
      const reconcileRoutes = (
        scriptName: string,
        desired: NormalizedWorkerRoute[],
        previous: Worker["Attributes"]["routes"],
      ) =>
        Effect.gen(function* () {
          const zoneIds = Array.from(
            new Set([
              ...desired.map((route) => route.zoneId),
              ...previous.map((route) => route.zoneId),
            ]),
          );
          const liveAll = yield* listWorkerRoutesInZones(scriptName, zoneIds);
          const desiredKeys = new Set(desired.map(routeKey));
          const liveByKey = new Map(
            liveAll.map((route) => [routeKey(route), route]),
          );

          const toRemove = liveAll.filter(
            (route) => !desiredKeys.has(routeKey(route)),
          );
          yield* Effect.all(
            toRemove.map((route) =>
              workers
                .deleteRoute({ zoneId: route.zoneId, routeId: route.id })
                .pipe(Effect.catchTag("RouteNotFound", () => Effect.void)),
            ),
            { concurrency: "unbounded" },
          );

          if (desired.length === 0) return [];

          const attachRoute = Effect.fn(function* (
            route: NormalizedWorkerRoute,
          ) {
            const existing = liveByKey.get(routeKey(route));
            if (existing) return existing;

            const zoneRoutes = yield* workers
              .listRoutes({ zoneId: route.zoneId })
              .pipe(
                Effect.map((response) => response.result ?? []),
                Effect.catch(() => Effect.succeed([])),
              );
            const otherOwner = zoneRoutes.find(
              (candidate) =>
                candidate.pattern === route.pattern &&
                candidate.script &&
                candidate.script !== scriptName,
            );
            if (otherOwner) {
              return yield* Effect.die(
                new Error(
                  `Cannot attach route '${route.pattern}' to Worker '${scriptName}': ` +
                    `it is already attached to Worker '${otherOwner.script}'. ` +
                    `Remove it from that Worker first, or pick a different pattern.`,
                ),
              );
            }

            // A duplicate-pattern failure means another actor (or a crashed
            // previous reconcile) created the route between our observation
            // and now — re-list and converge if it points at this script.
            const created = yield* workers
              .createRoute({
                zoneId: route.zoneId,
                pattern: route.pattern,
                script: scriptName,
              })
              .pipe(
                // Same eventual-consistency window as `putDomain`: creating
                // a route right after `putScript` can race Cloudflare's
                // script registry, which rejects with code 10019 ("Cannot
                // configure a route for a Worker which does not exist") —
                // typed as `RouteScriptNotFound` via the createRoute patch.
                Effect.retry({
                  while: (error) => error._tag === "RouteScriptNotFound",
                  schedule: Schedule.max([
                    Schedule.exponential(200),
                    Schedule.recurs(15),
                  ]),
                }),
                Effect.catchTag("InvalidRoute", (originalError) =>
                  Effect.gen(function* () {
                    const match = yield* workers
                      .listRoutes({ zoneId: route.zoneId })
                      .pipe(
                        Effect.map((response) =>
                          (response.result ?? []).find(
                            (candidate) =>
                              candidate.pattern === route.pattern &&
                              candidate.script === scriptName,
                          ),
                        ),
                        Effect.catch(() => Effect.succeed(undefined)),
                      );
                    if (!match?.id) {
                      return yield* Effect.fail(originalError);
                    }
                    return { id: match.id, pattern: match.pattern };
                  }),
                ),
              );
            return {
              id: created.id,
              pattern: created.pattern,
              zoneId: route.zoneId,
            };
          });

          return yield* Effect.all(desired.map(attachRoute), {
            concurrency: "unbounded",
          });
        });

      const createAlchemyWorkerTags = (id: string) => [
        `alchemy:stack:${stack.name}`,
        `alchemy:stage:${stack.stage}`,
        `alchemy:id:${id}`,
      ];

      const hasAlchemyWorkerTags = (
        id: string,
        tags: readonly string[] | undefined,
      ) => {
        const actualTags = new Set(tags ?? []);
        return createAlchemyWorkerTags(id).every((tag) => actualTags.has(tag));
      };

      /**
       * Resolve the source script of a declared Durable Object transfer for
       * a class that is new to `selfScriptName`. `sources` is the
       * `transferredFrom` host history: each entry names a former host either
       * by *physical script name* or by *Worker logical id* in this stack +
       * stage (matched via the `alchemy:id:`/stack/stage ownership tags).
       * The namespace is transferred from whichever listed host currently
       * holds a same-class namespace; when none does (fresh stage, or every
       * transfer already completed) this returns `undefined` and the caller
       * creates the class fresh — the declaration is inert and safe to keep.
       * More than one match (e.g. an orphaned script from a `name` change)
       * fails with {@link AmbiguousDurableObjectTransfer} rather than
       * guessing whose data to move.
       */
      const resolveTransferSource = Effect.fn(function* (params: {
        accountId: string;
        selfScriptName: string;
        logicalId: string;
        className: string;
        sources: readonly string[];
        observedNamespaces: readonly { script: string; class: string }[];
      }) {
        if (params.sources.length === 0) {
          return undefined;
        }
        const candidates = Array.from(
          new Set(
            params.observedNamespaces.flatMap((ns) =>
              ns.class === params.className &&
              ns.script !== params.selfScriptName
                ? [ns.script]
                : [],
            ),
          ),
        );
        const matched: string[] = [];
        for (const script of candidates) {
          if (params.sources.includes(script)) {
            matched.push(script);
            continue;
          }
          const settings = yield* getScriptSettings(
            params.accountId,
            script,
            undefined,
          ).pipe(
            Effect.catchTag("WorkerNotFound", () => Effect.succeed(undefined)),
            Effect.catchTag("WorkerHasNoVersions", () =>
              Effect.succeed(undefined),
            ),
          );
          const tags = new Set(settings?.tags ?? []);
          if (
            tags.has(`alchemy:stack:${stack.name}`) &&
            tags.has(`alchemy:stage:${stack.stage}`) &&
            params.sources.some((source) => tags.has(`alchemy:id:${source}`))
          ) {
            matched.push(script);
          }
        }
        if (matched.length > 1) {
          return yield* Effect.fail(
            new AmbiguousDurableObjectTransfer({
              scriptName: params.selfScriptName,
              logicalId: params.logicalId,
              className: params.className,
              sources: matched,
            }),
          );
        }
        return matched[0];
      });

      const getDurableObjects = (
        bindings: readonly WorkerSettingsBinding[] | null | undefined,
      ) => {
        const namespaces = Object.fromEntries(
          (bindings ?? []).flatMap((binding) =>
            binding.type === "durable_object_namespace" &&
            binding.className &&
            binding.namespaceId
              ? [[binding.className, binding.namespaceId]]
              : [],
          ),
        );
        return namespaces;
      };

      const getExpectedDurableObjectClassNames = (
        bindings: readonly WorkerBinding[] | undefined,
        workerName: string,
      ) =>
        Array.from(
          new Set(
            bindings?.flatMap((binding) =>
              binding.type === "durable_object_namespace" &&
              binding.className &&
              (binding.scriptName === undefined ||
                binding.scriptName === workerName)
                ? [binding.className]
                : [],
            ) ?? [],
          ),
        );

      const getWorkerSettingsWithDurableObjects = Effect.fn(function* (
        scriptName: string,
        expectedClassNames: readonly string[],
        dispatchNamespace?: string,
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        return yield* getScriptSettings(
          accountId,
          scriptName,
          dispatchNamespace,
        ).pipe(
          Effect.map((settings) => {
            const namespaces = getDurableObjects(settings.bindings);
            const missing = expectedClassNames.filter(
              (className) => !namespaces[className],
            );
            if (missing.length > 0) {
              return Effect.fail(
                new MissingDurableObjects({
                  scriptName,
                  expected: missing,
                }),
              );
            }
            return Effect.succeed({
              settings,
              durableObjectNamespaces: namespaces,
            });
          }),
          Effect.flatten,
          Effect.retry({
            // `MissingDurableObjects`: the DO bindings haven't
            // surfaced in the version settings yet. `WorkerHasNoVersions` /
            // `WorkerNotFound`: right after the first `putScript`, the
            // version-settings read can race the script registry — under a
            // busy account this read can briefly 404 with "has no versions"
            // (or the worker itself as not-yet-found) before the upload
            // propagates. All three are eventual-consistency blips.
            while: (error) =>
              error._tag === "MissingDurableObjects" ||
              error._tag === "WorkerHasNoVersions" ||
              error._tag === "WorkerNotFound" ||
              error._tag === "DispatchNamespaceScriptNotFound" ||
              error._tag === "DispatchNamespaceNotFound",
            schedule: Schedule.max([
              Schedule.exponential(100),
              Schedule.recurs(20),
            ]),
          }),
        );
      });

      const prepareAssets = Effect.fn(function* (
        assets: WorkerProps["assets"],
      ) {
        if (!assets) {
          return undefined;
        }

        if (typeof assets === "object" && "hash" in assets) {
          const { hash: _, ...config } = assets;
          return yield* readAssets(config);
        }

        // Handle string path or AssetsProps
        return yield* readAssets(
          typeof assets === "string" ? { directory: assets } : assets,
        );
      });

      const prepareBundle = (id: string, props: WorkerProps) =>
        (isPythonMain(props.main)
          ? readPythonWorkerBundle({
              id,
              main: props.main,
              compatibility: getCompatibility(props),
            })
          : props.bundle === false
            ? readPrebuiltWorkerBundle({
                main: props.main!,
                rules: props.rules,
              })
            : bundler.build({
                id,
                main: props.main!,
                compatibility: getCompatibility(props),
                entry: props.isExternal
                  ? {
                      kind: "external",
                    }
                  : {
                      kind: "effect",
                      exports: props.exports ?? {},
                    },
                stack: { name: stack.name, stage: stack.stage },
                extraOptions: props.build,
              })
        ).pipe(Artifacts.cached("build"));

      const hashScript = (script: string) =>
        Effect.sync(() =>
          crypto.createHash("sha256").update(script).digest("hex"),
        );

      const viteBuild = Effect.fn(function* (
        props: WorkerProps,
        selfUrl?: string,
      ) {
        const compatibility = getCompatibility(props);
        const Vite = yield* loadVite;
        const { clientDirectory, base, serverBundle, externalWorkspaces } =
          yield* Vite.viteBuild(
            props.vite?.rootDir,
            Object.fromEntries(
              (yield* Effect.all(
                Object.entries(props.env ?? {}).map(
                  Effect.fn(function* ([key, value]) {
                    return [
                      key,
                      typeof value === "string"
                        ? value
                        : Redacted.isRedacted(value) &&
                            typeof Redacted.value(value) === "string"
                          ? Redacted.value(value)
                          : // `Worker.URL` (bare tag or called) — resolved to
                            // this Worker's own URL. The bare tag is
                            // Effect-shaped, so check before `Effect.isEffect`.
                            isSelfUrl(value)
                            ? selfUrl
                            : // A `WorkerLoader` is a real Effect that also carries
                              // the `~alchemy/Kind` marker — it is a binding, not a
                              // runnable env value. Check it before `Effect.isEffect`
                              // so we don't execute it as an inlined env entry.
                              isWorkerLoader(value)
                              ? undefined
                              : // A `Cloudflare.Container` declaration is likewise
                                // Effect-shaped but is a binding (DO namespace +
                                // ContainerApplication) — yielding it would resolve
                                // the started-instance tag, which only exists inside
                                // a Durable Object (#997).
                                isContainerDecl(value)
                                ? undefined
                                : Effect.isEffect(value)
                                  ? yield* value as any as Effect.Effect<any>
                                  : undefined,
                    ];
                  }),
                ),
              )).filter(([_, value]) => value !== undefined),
            ),
            {
              // A relative `vite.main` is documented to resolve from the Vite
              // root. The rolldown plugin resolves the worker entry with no
              // importer (i.e. against `process.cwd()`), which breaks when the
              // deploy runs from a different directory (e.g. a monorepo infra
              // package) — absolutize before handing it over (#796).
              main: props.vite?.main
                ? path.resolve(
                    initialCwd,
                    props.vite.rootDir ?? ".",
                    props.vite.main,
                  )
                : undefined,
              compatibilityDate: compatibility.date,
              compatibilityFlags: compatibility.flags,
              viteEnvironments: props.vite?.viteEnvironments,
            },
          );
        const [assets, bundle, input] = yield* Effect.all(
          [
            clientDirectory
              ? readAssets({
                  ...(props.assets && typeof props.assets !== "string"
                    ? props.assets
                    : undefined),
                  // `clientDirectory` from the build child is absolute;
                  // the base only matters as a legacy fallback.
                  directory: path.resolve(
                    initialCwd,
                    props.vite?.rootDir ?? ".",
                    clientDirectory,
                  ),
                  // The resolved Vite `base` is what rewrote the URLs in
                  // the emitted HTML, so it is the only prefix the
                  // manifest can agree with.
                  base,
                })
              : Effect.undefined,
            serverBundle,
            Vite.hashViteInput(
              props.vite?.rootDir,
              props.vite?.memo,
              externalWorkspaces,
            ),
          ],
          { concurrency: "unbounded" },
        );
        if (!assets && !bundle) {
          return yield* Effect.die(
            new Error("Vite build produced neither assets nor server output"),
          );
        }
        return {
          assets,
          bundle,
          input: input.hash,
          additionalWorkspaces: input.workspaces,
        };
      });

      // Loaded lazily: `./Sources/Vite.ts` pulls in
      // `@alchemy.run/cloudflare-runtime/vite` (~0.5s), which is only
      // needed for vite-based workers at build time — not for every Worker
      // definition at module-load time.
      const loadVite = Effect.promise(() => import("./Sources/Vite.ts"));

      const prepareAssetsAndBundle = (
        id: string,
        workerName: string,
        props: WorkerProps,
        opts: { skipAssetsRead?: boolean; selfUrl?: string } = {},
      ) =>
        Effect.gen(function* () {
          // External source provider (`props.source`): the provider is
          // self-contained — it supplies the bundle, optionally its own
          // assets (framework builds), and the hash slots it owns. The
          // props-level `assets` directory is still read here for sources
          // that don't own assets.
          if (props.source) {
            const source = yield* resolveSource(props);
            const ctx = makeSourceContext({
              id,
              workerName,
              props,
              compatibility: getCompatibility(props),
              stack: { name: stack.name, stage: stack.stage },
            });
            const [output, propsAssets] = yield* Effect.all(
              [
                source.build(ctx),
                source.ownsAssets || opts.skipAssetsRead
                  ? Effect.undefined
                  : prepareAssets(props.assets),
              ],
              { concurrency: "unbounded" },
            );
            return {
              assets: output.assets ?? propsAssets,
              bundle: output.bundle,
              input: output.hash.input,
              additionalWorkspaces: output.hash.additionalWorkspaces,
            };
          }
          if (props.script !== undefined) {
            const [assets, bundleHash] = yield* Effect.all(
              [
                opts.skipAssetsRead
                  ? Effect.succeed(undefined)
                  : prepareAssets(props.assets),
                hashScript(props.script),
              ],
              { concurrency: "unbounded" },
            );
            return {
              assets,
              bundle: {
                files: [{ path: "main.js", content: props.script }],
                hash: bundleHash,
              },
              input: undefined,
              additionalWorkspaces: undefined,
            };
          }
          if (props.vite) {
            return yield* viteBuild(props, opts.selfUrl);
          }
          // Assets-only Worker: no entry module at all. The script PUT goes
          // out with no modules and no main_module — Cloudflare's asset
          // layer serves every request and applies `notFoundHandling`
          // (including SPA fallback) itself, exactly like Wrangler's
          // assets-only deploys.
          if (props.main === undefined) {
            if (!props.assets) {
              return yield* Effect.die(
                new Error(
                  `Worker "${id}" has no main, script, or assets. Provide an entry module (main / script) or an assets directory to deploy an assets-only Worker.`,
                ),
              );
            }
            return {
              assets: opts.skipAssetsRead
                ? undefined
                : yield* prepareAssets(props.assets),
              bundle: undefined,
              input: undefined,
              additionalWorkspaces: undefined,
            };
          }
          const [assets, bundle] = yield* Effect.all(
            [
              opts.skipAssetsRead
                ? Effect.succeed(undefined)
                : prepareAssets(props.assets),
              prepareBundle(id, props),
            ],
            { concurrency: "unbounded" },
          );
          return {
            assets,
            bundle,
            input: undefined,
            additionalWorkspaces: undefined,
          };
        }).pipe(
          Effect.map(({ assets, bundle, input, additionalWorkspaces }) => ({
            assets,
            bundle: {
              main: bundle?.files[0].path,
              files: bundle?.files.map(
                (file) =>
                  new File([file.content as BlobPart], file.path, {
                    type: contentTypeForModule(file.path),
                  }),
              ),
            },
            hash: {
              assets: assets?.hash,
              bundle: bundle?.hash,
              input,
              additionalWorkspaces,
            } satisfies Worker["Attributes"]["hash"],
          })),
        );

      const normalizePrebuiltAssets = (
        assets: WorkerProps["assets"],
        output: Worker["Attributes"] | undefined,
      ) => {
        // An explicitly-undefined `hash` (`{ directory, hash: maybe }`) is
        // the hash-less shape, not a supplied hash — the same rule
        // `assetsChanged` applies during diff. Without the `undefined` check
        // a greenfield create (`output === undefined`) compares `undefined
        // === undefined`, sets `skip`, and uploads a Worker with no assets.
        if (
          !Predicate.hasProperty(assets, "hash") ||
          assets.hash === undefined
        ) {
          return undefined;
        }
        // `base` shapes the uploaded manifest paths (see `readAssets`); it
        // is alchemy-only and must not leak into the API's asset config.
        const { directory, hash, base, ...config } = assets;
        // `base` re-keys the manifest without changing the build output, so
        // a caller-supplied hash alone would let the skip path carry a
        // stale root-keyed manifest forward across a `base` change. Salt
        // the stored/compared hash with the prefix; unprefixed deploys keep
        // their existing hashes.
        const pathPrefix = getAssetsPathPrefix(base);
        const effectiveHash = pathPrefix ? `${hash}#base=${pathPrefix}` : hash;
        return {
          directory,
          config,
          hash: effectiveHash,
          skip: effectiveHash === output?.hash?.assets,
        };
      };

      /**
       * Append the standard Alchemy runtime bindings plus the user's `env`
       * entries (routed by shape: `Redacted` → secret_text, string →
       * plain_text, everything else → json) to a metadata binding list.
       * Shared between the full script upload and the version upload.
       */
      const appendAlchemyAndEnvBindings = (
        metadataBindings: WorkerBinding[],
        news: WorkerProps,
        accountId: string,
        workerName: string,
      ) => {
        metadataBindings.push(
          {
            type: "plain_text",
            name: "ALCHEMY_PHASE",
            text: "runtime",
          },
          {
            type: "plain_text",
            name: "ALCHEMY_WORKER_NAME",
            text: workerName,
          },
          {
            type: "plain_text",
            name: "ALCHEMY_STACK_NAME",
            text: stack.name,
          },
          {
            type: "plain_text",
            name: "ALCHEMY_STAGE",
            text: stack.stage,
          },
          {
            type: "plain_text",
            name: "ALCHEMY_CLOUDFLARE_ACCOUNT_ID",
            text: accountId,
          },
        );
        // Add environment variables as metadata bindings
        if (news.env) {
          for (const [key, value] of Object.entries(news.env)) {
            if (value === undefined) continue;
            if (metadataBindings.some((b) => b.name === key)) continue;
            if (Redacted.isRedacted(value)) {
              const unredacted = Redacted.value(value);
              metadataBindings.push({
                type: "secret_text",
                name: key,
                text:
                  typeof unredacted === "string"
                    ? unredacted
                    : JSON.stringify(unredacted),
              });
            } else if (typeof value === "string") {
              metadataBindings.push({
                type: "plain_text",
                name: key,
                text: value,
              });
            } else {
              metadataBindings.push({
                type: "json",
                name: key,
                json: value,
              });
            }
          }
        }
      };

      /**
       * Create a deployment routing `traffic`% to `versionId`, with the
       * remainder staying on the currently-live version (the
       * highest-percentage version of the script's latest deployment).
       * `traffic >= 100` — or a script with no other live version to split
       * against — deploys the new version at 100%.
       */
      const deployVersionTraffic = Effect.fn(function* (params: {
        accountId: string;
        scriptName: string;
        versionId: string;
        traffic: number;
        message: string | undefined;
      }) {
        const { accountId, scriptName, versionId, traffic } = params;
        const split = yield* Effect.gen(function* () {
          if (traffic >= 100) {
            return [{ versionId, percentage: 100 }];
          }
          const { deployments } = yield* workers.listScriptDeployments({
            accountId,
            scriptName,
          });
          // Deployments are returned newest-first; the live version is the
          // highest-percentage version of the most recent deployment.
          const stable = deployments[0]?.versions
            .filter((v) => v.versionId !== versionId)
            .sort((a, b) => b.percentage - a.percentage)[0];
          if (!stable) {
            // Nothing to split against (first deployment of this script).
            return [{ versionId, percentage: 100 }];
          }
          return [
            { versionId, percentage: traffic },
            { versionId: stable.versionId, percentage: 100 - traffic },
          ];
        });
        const deployment = yield* workers.createScriptDeployment({
          accountId,
          scriptName,
          strategy: "percentage",
          versions: split,
          annotations: params.message
            ? { workersMessage: params.message }
            : undefined,
        });
        return deployment.id;
      });

      /**
       * Resolve the preview-URL alias for a version worker: the
       * user-provided `version.alias` (validated against Cloudflare's
       * naming rules), or an alias derived from the stack, stage, and
       * logical id — stable across deploys, so the aliased preview URL
       * (`<alias>-<script>.<subdomain>.workers.dev`) is a durable link
       * that always points at the latest uploaded version. Returns
       * `undefined` when the parent's script name leaves no room in the
       * 63-character DNS label and no explicit alias was given.
       */
      const resolveVersionAlias = Effect.fn(function* (
        id: string,
        news: WorkerProps,
        parentName: string,
      ) {
        // `<alias>-<script name>` is a single DNS label (≤ 63 chars).
        const budget = 63 - parentName.length - 1;
        const userAlias = news.version?.alias;
        if (userAlias !== undefined) {
          if (!/^[a-z][a-z0-9-]*$/.test(userAlias)) {
            return yield* Effect.fail(
              new WorkerVersionConfigError({
                message: `version.alias '${userAlias}' is invalid: aliases must start with a lowercase letter and contain only lowercase letters, digits, and dashes.`,
              }),
            );
          }
          if (userAlias.length > budget) {
            return yield* Effect.fail(
              new WorkerVersionConfigError({
                message: `version.alias '${userAlias}' is too long: '<alias>-${parentName}' must fit in a 63-character DNS label, leaving ${Math.max(budget, 0)} characters for the alias.`,
              }),
            );
          }
          return userAlias;
        }
        if (budget < 4) {
          return undefined;
        }
        // Deterministic per (stack, stage, id) — survives updates AND
        // replacements so the aliased preview URL never moves. A short
        // hash disambiguates different stacks/stages whose readable
        // prefixes collide after truncation.
        const hash = yield* Effect.sync(() =>
          crypto
            .createHash("sha256")
            .update(`${stack.name}/${stack.stage}/${id}`)
            .digest("hex")
            .slice(0, 6),
        );
        const readable = `${stack.stage}-${id}`
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .replace(/^-+|-+$/g, "");
        const alias = [readable, hash]
          .filter((part) => part.length > 0)
          .join("-")
          .slice(0, budget)
          .replace(/-+$/, "");
        return /^[a-z]/.test(alias) ? alias : `v${alias}`.slice(0, budget);
      });

      /**
       * The parent's workers.dev preview settings + account subdomain,
       * fetched once per version reconcile. Preview URLs (aliased and
       * versioned) only serve when the parent has previews enabled.
       */
      const resolveVersionPreviewContext = Effect.fn(function* (
        accountId: string,
        scriptName: string,
      ) {
        const subdomain = yield* workers
          .getScriptSubdomain({ accountId, scriptName })
          .pipe(
            Effect.orElseSucceed<workers.GetScriptSubdomainResponse>(() => ({
              enabled: false,
              previewsEnabled: false,
            })),
          );
        const accountSubdomain = yield* getAccountSubdomain(accountId);
        return {
          previewsEnabled: subdomain.previewsEnabled === true,
          accountSubdomain,
        };
      });

      /**
       * Reject props that can't ride along on a *version worker*
       * (`version.parent` set). A version carries only code, bindings, and
       * compatibility settings; everything script-level belongs to the
       * parent and must not be mutated from a version resource. Locally
       * hosted Durable Object / Workflow classes are rejected because their
       * migrations would apply to the parent script when the version
       * deploys.
       */
      const validateVersionWorkerProps = Effect.fn(function* (
        news: WorkerProps,
        bindings: ResourceBinding<Worker["Binding"]>[],
        parentName: string,
      ) {
        const forbidden = (
          [
            ["name", news.name],
            ["namespace", news.namespace],
            ["crons", news.crons],
            ["tailConsumers", news.tailConsumers],
            ["streamingTailConsumers", news.streamingTailConsumers],
            ["domain", news.domain],
            ["routes", news.routes],
            ["tags", news.tags],
            ["logpush", news.logpush],
            ["observability", news.observability],
            ["placement", news.placement],
            ["limits", news.limits],
            ["workersDev", news.workersDev],
            ["access", news.access],
            ["vite", news.vite],
          ] as const
        ).flatMap(([key, value]) => (value !== undefined ? [key] : []));
        if (forbidden.length > 0) {
          return yield* Effect.fail(
            new WorkerVersionConfigError({
              message:
                `version.parent uploads a version of '${parentName}' — script-level settings belong to the parent Worker and cannot be set here: ${forbidden.join(", ")}. ` +
                `Remove ${forbidden.length === 1 ? "this prop" : "these props"} or configure ${forbidden.length === 1 ? "it" : "them"} on the parent.`,
            }),
          );
        }
        yield* validateTraffic(news.version?.traffic);
        const cronBindings = getCronBindings(bindings);
        if (cronBindings.length > 0) {
          return yield* Effect.fail(
            new WorkerVersionConfigError({
              message: `Cron Triggers are script-level settings and cannot be registered from a version of '${parentName}'. Configure crons on the parent Worker.`,
            }),
          );
        }
        // Any locally-hosted DO class (a durable_object_namespace binding
        // without a foreign scriptName) or DO/Workflow export would require
        // migrations, which the versions API can't carry — and which would
        // mutate the parent's namespaces.
        const hostedClasses = getDurableObjectBindings(bindings, parentName);
        const exportedClasses = Object.keys(news.exports ?? {});
        if (hostedClasses.length > 0 || exportedClasses.length > 0) {
          return yield* Effect.fail(
            new WorkerVersionConfigError({
              message: `A version of '${parentName}' cannot host Durable Object or Workflow classes (${[
                ...new Set([
                  ...hostedClasses.map((c) => c.className),
                  ...exportedClasses,
                ]),
              ].join(
                ", ",
              )}): class migrations apply to the parent script. Host the classes on the parent Worker and reference them cross-script instead.`,
            }),
          );
        }
      });

      /**
       * Reconcile a *version worker*: upload this Worker's code + bindings
       * as an immutable version of the parent's script (no script of its
       * own), then optionally shift `version.traffic`% of the parent's
       * traffic to it. Idempotent in the reconciler sense: every run
       * converges cloud state to "the parent's script has a version with
       * exactly this content, receiving exactly this traffic" — re-running
       * with changed content simply uploads the next immutable version.
       */
      const putWorkerVersion = Effect.fn(function* (
        id: string,
        news: WorkerProps,
        bindings: ResourceBinding<Worker["Binding"]>[],
        session: ScopedPlanStatusSession,
        output: Worker["Attributes"] | undefined,
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const version = news.version!;
        const parentName = resolveVersionParentName(version);
        if (parentName === undefined) {
          return yield* Effect.fail(
            new WorkerVersionConfigError({
              message: `version.parent did not resolve to a Worker script name. Pass a Worker (e.g. \`yield* Cloudflare.Worker.ref(id, { stage })\`) or a literal script name.`,
            }),
          );
        }
        yield* validateVersionWorkerProps(news, bindings, parentName);
        const traffic = version.traffic ?? 0;
        // Resolve the alias and preview context BEFORE the upload: the
        // aliased preview URL (`<alias>-<script>.<subdomain>.workers.dev`)
        // is deterministic ahead of time — unlike the versioned URL, whose
        // prefix comes from the server-assigned version id — which is what
        // lets a `Worker.URL` (self_url) binding be baked into the
        // version's own bindings.
        const alias = yield* resolveVersionAlias(id, news, parentName);
        const { previewsEnabled, accountSubdomain } =
          yield* resolveVersionPreviewContext(accountId, parentName);
        const aliasedUrl =
          alias !== undefined && previewsEnabled
            ? `https://${alias}-${parentName}.${accountSubdomain}.workers.dev`
            : undefined;
        const selfUrl = hasSelfUrlBinding(bindings) ? aliasedUrl : undefined;
        if (hasSelfUrlBinding(bindings) && selfUrl === undefined) {
          return yield* Effect.fail(
            new WorkerVersionConfigError({
              message: previewsEnabled
                ? `A version of '${parentName}' binds its own URL (Worker.URL), but no preview alias fits: '<alias>-${parentName}' must stay within a 63-character DNS label. Set a short version.alias or shorten the parent's name.`
                : `A version of '${parentName}' binds its own URL (Worker.URL), but the parent's workers.dev previews are disabled — a version's URL is its aliased preview URL. Enable the parent's workers.dev subdomain (url: true, the default).`,
            }),
          );
        }
        yield* Effect.logInfo(
          `Cloudflare Worker version: preparing bundle for ${parentName} (from ${id})`,
        );
        const {
          assets,
          bundle,
          hash: preparedHash,
        } = yield* prepareAssetsAndBundle(id, parentName, news, {
          skipAssetsRead: false,
        });
        const metadataHash = yield* resolveWorkerMetadataHash({
          props: news,
          bindings,
          accountId,
          stack: { name: stack.name, stage: stack.stage },
          selfUrl,
        });
        const hash = {
          ...preparedHash,
          metadata: metadataHash,
        } satisfies Worker["Attributes"]["hash"];
        // Lower the `Worker.URL` sentinel into the aliased preview URL —
        // same lowering `putWorker` performs, with the alias standing in
        // for the script's own URL. `Worker.Self` lowers to a
        // service binding on the parent script (versions have no name of
        // their own).
        const metadataBindings = bindings.flatMap((b) =>
          (b.data.bindings ?? []).map((item) =>
            item.type === "self_url"
              ? { type: "plain_text" as const, name: item.name, text: selfUrl! }
              : item.type === "self_service"
                ? {
                    type: "service" as const,
                    name: item.name,
                    service: parentName,
                  }
                : item,
          ),
        );
        let metadataAssets:
          | workers.CreateScriptVersionRequest["metadata"]["assets"]
          | undefined;
        if (assets) {
          yield* Effect.logInfo(
            `Cloudflare Worker version: uploading assets for ${parentName}`,
          );
          const { jwt } = yield* uploadAssets(
            accountId,
            parentName,
            assets,
            session,
          );
          metadataAssets = {
            jwt,
            config: mergeAssetsConfigFiles(assets.config, assets),
          };
          metadataBindings.push({ type: "assets", name: "ASSETS" });
        }
        appendAlchemyAndEnvBindings(
          metadataBindings,
          news,
          accountId,
          parentName,
        );
        const compatibility = getCompatibility(news);
        yield* session.note(`Uploading version of ${parentName} ...`);
        const created = yield* workers
          .createScriptVersion({
            accountId,
            scriptName: parentName,
            metadata: {
              mainModule: bundle.main!,
              assets: metadataAssets,
              bindings: metadataBindings,
              compatibilityDate: compatibility.date,
              compatibilityFlags: compatibility.flags,
              cacheOptions: news.cache ?? getCacheBinding(bindings),
              annotations:
                alias !== undefined ||
                version.message !== undefined ||
                version.tag !== undefined
                  ? {
                      workersAlias: alias,
                      workersMessage: version.message,
                      workersTag: version.tag,
                    }
                  : undefined,
            },
            files: bundle.files,
          })
          .pipe(
            Effect.retry({
              while: isBindingTargetNotFound,
              schedule: bindingTargetNotFoundRetrySchedule(),
            }),
            Effect.catchTag("WorkerNotFound", () =>
              Effect.fail(
                new WorkerVersionConfigError({
                  message: `version.parent script '${parentName}' does not exist. Deploy the parent Worker first (or check the referenced stage/stack).`,
                }),
              ),
            ),
          );
        const versionId = created.id ?? undefined;
        if (versionId === undefined) {
          return yield* Effect.fail(
            new WorkerVersionConfigError({
              message: `Cloudflare did not return a version id for the uploaded version of '${parentName}'.`,
            }),
          );
        }
        let deploymentId: string | undefined;
        if (traffic > 0) {
          yield* session.note(
            `Deploying version at ${traffic}% of ${parentName}'s traffic ...`,
          );
          deploymentId = yield* deployVersionTraffic({
            accountId,
            scriptName: parentName,
            versionId,
            traffic,
            message: version.message,
          });
        }
        // Version-affinity transform rules (`version.affinity`): a canary
        // rides the *parent's* zone traffic, so the rules land on the
        // parent's zones — observed custom-domain attachments plus, when
        // `parent` was passed as a Worker resource, its recorded routes.
        const previousAffinityZoneIds = output?.affinityZoneIds ?? [];
        let affinityZoneIds: string[] | undefined;
        if (version.affinity !== undefined || previousAffinityZoneIds.length) {
          const resolvedAffinity =
            version.affinity !== undefined
              ? yield* resolveVersionAffinity(version.affinity)
              : undefined;
          let hostsByZone: Map<string, AffinityZoneHost[]> | undefined;
          if (resolvedAffinity !== undefined) {
            hostsByZone = new Map();
            const addHost = (zoneId: string, host: AffinityZoneHost) => {
              const hosts = hostsByZone!.get(zoneId) ?? [];
              hosts.push(host);
              hostsByZone!.set(zoneId, hosts);
            };
            // A `version.parent` passed as a Worker resource resolves to
            // the parent's Attributes at reconcile time (see
            // resolveVersionParentName) — its recorded routes and domain
            // tell us the zones the parent serves on.
            const parentAttrs =
              typeof version.parent === "object" && version.parent !== null
                ? (version.parent as unknown as Partial<Worker["Attributes"]>)
                : undefined;
            const redirectHosts = new Set(parentAttrs?.domain?.redirects ?? []);
            const attached = yield* workers
              .listDomains({ accountId, service: parentName })
              .pipe(Effect.map((r) => r.result ?? []));
            for (const d of attached) {
              if (!d.hostname || !d.zoneId || redirectHosts.has(d.hostname)) {
                continue;
              }
              addHost(d.zoneId, { host: d.hostname, wildcard: false });
            }
            for (const route of parentAttrs?.routes ?? []) {
              const host = route.pattern.split("/")[0];
              if (!host || host.includes('"')) continue;
              addHost(route.zoneId, { host, wildcard: host.includes("*") });
            }
            if (hostsByZone.size === 0) {
              return yield* Effect.fail(
                new WorkerVersionConfigError({
                  message:
                    `version.affinity pins users via a zone Transform Rule setting the ${AFFINITY_HEADER} header, which only sees zone traffic — the parent '${parentName}' has no custom domains (or recorded zone routes) to place the rule on. ` +
                    `Give the parent a \`domain\` or zone \`routes\`, or pass the parent as a Worker resource so its routes are visible here.`,
                }),
              );
            }
            yield* session.note("Reconciling version-affinity rules ...");
          }
          const placed = yield* reconcileAffinityRules({
            scriptName: parentName,
            desired:
              resolvedAffinity !== undefined && hostsByZone !== undefined
                ? { affinity: resolvedAffinity, hostsByZone }
                : undefined,
            previousZoneIds: previousAffinityZoneIds,
          });
          affinityZoneIds = placed.length > 0 ? placed : undefined;
        }
        // The aliased URL is primary (`url`): it is stable across deploys,
        // re-pointing at each newly uploaded version. The per-version URL
        // (prefixed by the version id) rides along in `urls`.
        const versionedUrl = previewsEnabled
          ? `https://${versionId.split("-")[0]}-${parentName}.${accountSubdomain}.workers.dev`
          : undefined;
        const urls = [
          ...(aliasedUrl ? [aliasedUrl] : []),
          ...(versionedUrl ? [versionedUrl] : []),
        ];
        return {
          // A version worker never owns a script — carry the *parent*
          // script's immutable ID (its preview URLs are protected through
          // the parent).
          workerId:
            cachedWorkerId(output?.workerId, parentName) ??
            (yield* findWorkerId(accountId, parentName)),
          workerName: parentName,
          namespace: undefined,
          logpush: undefined,
          url: urls[0],
          urls,
          domain: undefined,
          tags: undefined,
          durableObjectNamespaces: {},
          accountId,
          routes: [],
          crons: [],
          versionOf: parentName,
          versionId,
          versionAlias: alias,
          deploymentId,
          affinityZoneIds,
          hash,
        } satisfies Worker["Attributes"];
      });

      const putWorker = Effect.fn(function* (
        id: string,
        news: WorkerProps,
        bindings: ResourceBinding<Worker["Binding"]>[],
        olds: WorkerProps | undefined,
        output: Worker["Attributes"] | undefined,
        session: ScopedPlanStatusSession,
        existingSettings?: workers.GetScriptScriptAndVersionSettingResponse,
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        // Prefer the deployed name: regenerating would target a different
        // script if the generator's output for this id ever drifts.
        const name =
          output?.workerName ?? (yield* createWorkerName(id, news.name));
        // When set, this Worker is a Workers for Platforms "user worker"
        // uploaded into a dispatch namespace rather than a routable
        // account-level script. The put/settings calls switch endpoints and
        // the subdomain / custom-domain / cron reconciliation is skipped.
        const dispatchNamespace = resolveNamespaceName(news?.namespace);
        yield* validateTraffic(news.version?.traffic);
        if (news.version !== undefined && dispatchNamespace) {
          return yield* Effect.fail(
            new WorkerVersionConfigError({
              message: `Workers for Platforms user workers do not support versions or gradual deployments — remove the version prop from '${name}'.`,
            }),
          );
        }
        // Resolve the Worker's own URL up front when a `Worker.URL` binding
        // is present: the value must exist before the bundle is built (Vite
        // inlines VITE_*-prefixed env into the client bundle) and before the
        // metadata bindings are assembled (the `self_url` sentinel lowers
        // into a plain_text binding below).
        const selfUrl = hasSelfUrlBinding(bindings)
          ? dispatchNamespace
            ? yield* Effect.die(
                `Worker "${name}" binds its own URL (Worker.URL), but a dispatch-namespace user worker is invoked via dynamic dispatch and has no URL of its own.`,
              )
            : yield* resolveSelfUrl(name, news, accountId)
          : undefined;
        yield* Effect.logInfo(
          `Cloudflare Worker ${olds ? "update" : "create"}: preparing bundle for ${name}`,
        );
        // If the caller handed us a precomputed asset hash that matches
        // what we previously stored, we can skip walking the directory
        // entirely and tell Cloudflare to keep the assets it already
        // has bound to this script. The disk read is the expensive
        // part; the script PUT happens either way.
        const prebuiltAssets = normalizePrebuiltAssets(news.assets, output);
        const {
          assets,
          bundle,
          hash: preparedHash,
        } = yield* prepareAssetsAndBundle(id, name, news, {
          skipAssetsRead: prebuiltAssets?.skip,
          selfUrl,
        });
        // When the caller supplied a precomputed hash (e.g. via
        // `Command.Build`), store *that* hash in output state so the
        // next diff can short-circuit by comparing it directly. The
        // hash that `readAssets` produces is the manifest-derived
        // hash, which is shaped differently from any upstream
        // build-input hash and will never match it on the next pass.
        const metadataHash = yield* resolveWorkerMetadataHash({
          props: news,
          bindings,
          accountId,
          stack: { name: stack.name, stage: stack.stage },
          selfUrl,
        });
        const hash = {
          ...preparedHash,
          assets: prebuiltAssets?.hash ?? preparedHash.assets,
          metadata: metadataHash,
        } satisfies Worker["Attributes"]["hash"];
        // `transferredFrom` is alchemy-only transfer metadata on
        // durable_object_namespace bindings — it drives the
        // `transferred_classes` migration below and must be stripped from the
        // wire-shape binding before upload.
        const metadataBindings = bindings.flatMap((b) =>
          (b.data.bindings ?? []).map((item): WireWorkerBinding => {
            // Lower the `Worker.URL` sentinel into the resolved URL —
            // Cloudflare has no native binding for it.
            if (item.type === "self_url") {
              return { type: "plain_text", name: item.name, text: selfUrl! };
            }
            // Lower the `Worker.Self` sentinel into a service
            // binding targeting this Worker's own physical name.
            if (item.type === "self_service") {
              return { type: "service", name: item.name, service: name };
            }
            if (
              item.type === "durable_object_namespace" &&
              item.transferredFrom !== undefined
            ) {
              const { transferredFrom: _, ...rest } = item;
              return rest;
            }
            // `queueId` (mode discrimination) and `shim` (dev-mode remote
            // producer) are alchemy-only metadata on queue bindings — strip
            // them from the wire shape.
            if (
              item.type === "queue" &&
              (item.queueId !== undefined || item.shim !== undefined)
            ) {
              const { queueId: _, shim: __, ...rest } = item;
              return rest;
            }
            return item;
          }),
        );
        const expectedDurableObjectClassNames =
          getExpectedDurableObjectClassNames(metadataBindings, name);
        let metadataAssets:
          | workers.PutScriptRequest["metadata"]["assets"]
          | undefined;
        let keepAssets = false;
        if (prebuiltAssets?.skip) {
          // Hash matched what's already on Cloudflare: keep the
          // existing asset manifest and skip the upload session.
          yield* Effect.logInfo(
            `Cloudflare Worker update: assets unchanged for ${name}, keeping existing`,
          );
          keepAssets = true;
          // `keepAssets` only preserves the uploaded files — the PUT
          // replaces the asset config wholesale. The skip path never
          // walked the directory, so read just `_headers`/`_redirects`
          // here or a no-op deploy would wipe their rules.
          metadataAssets = {
            config: mergeAssetsConfigFiles(
              prebuiltAssets.config,
              yield* readAssetsConfigFiles(prebuiltAssets.directory),
            ),
          };
          metadataBindings.push({
            type: "assets",
            name: "ASSETS",
          });
        } else if (assets) {
          // We had to read the directory. Even after the read, the
          // computed hash may match what's already deployed (e.g.
          // legacy `string` / `AssetsProps` shapes that don't carry a
          // precomputed hash, or a precomputed hash that disagreed with
          // disk). In that case still keep the existing manifest and
          // skip the upload session — Cloudflare's content-addressed
          // session would no-op on every byte anyway.
          if (assets.hash === prebuiltAssets?.hash) {
            yield* Effect.logInfo(
              `Cloudflare Worker update: assets unchanged for ${name}, keeping existing`,
            );
            keepAssets = true;
            // Fold the build-emitted `_headers`/`_redirects` into the PUT
            // config: source providers (Astro/SvelteKit/Waku/Nuxt) hash the
            // files and carry them on the read result, but only `readAssets`
            // pre-merges them — without this, framework header/redirect
            // rules never reach Cloudflare. Idempotent for pre-merged
            // configs (explicit config wins).
            metadataAssets = {
              config: mergeAssetsConfigFiles(assets.config, assets),
            };
          } else {
            yield* Effect.logInfo(
              `Cloudflare Worker ${olds ? "update" : "create"}: uploading assets for ${name}`,
            );
            const { jwt } = yield* uploadAssets(
              accountId,
              name,
              assets,
              session,
              dispatchNamespace,
            );
            metadataAssets = {
              jwt,
              // Same `_headers`/`_redirects` fold as the keep path above.
              config: mergeAssetsConfigFiles(assets.config, assets),
            };
          }
          metadataBindings.push({
            type: "assets",
            name: "ASSETS",
          });
        }
        appendAlchemyAndEnvBindings(metadataBindings, news, accountId, name);
        yield* Effect.logInfo(
          `Cloudflare Worker ${olds ? "update" : "create"}: uploading script for ${name}`,
        );
        const size =
          bundle.files
            ?.filter((file) => !file.name.endsWith(".map"))
            .reduce((acc, file) => acc + file.size, 0) ?? 0;
        const sizeKB = size / 1024;
        const sizeMB = sizeKB / 1024;
        const bundleSize = `${sizeKB > 1024 ? `${sizeMB.toFixed(2)} MB` : `${sizeKB.toFixed(2)} KB`}`;
        yield* session.note(`Uploading worker (${bundleSize}) ...`);

        // Read existing worker settings for migration tracking
        const oldSettings =
          existingSettings ??
          (yield* workers
            .getScriptScriptAndVersionSetting({
              accountId,
              scriptName: name,
            })
            .pipe(
              Effect.map((s) => s as typeof s | undefined),
              Effect.catch(() => Effect.succeed(undefined)),
            ));

        const oldTags = Array.from(new Set(oldSettings?.tags ?? []));
        const oldBindings = oldSettings?.bindings ?? [];

        // Parse the DO logical-id→class mapping from script tags (packed
        // `alchemy:dos:` and legacy per-DO `alchemy:do:` formats)
        const oldDoClassNameByLogicalId = getDurableObjectTagMap(oldTags);
        const currentDoBindings = getDurableObjectBindings(bindings, name);
        const currentDoClassNameByLogicalId = Object.fromEntries(
          currentDoBindings.map((binding) => [
            binding.logicalId,
            binding.className,
          ]),
        );

        // Parse alchemy:migration-tag:{version}
        const oldMigrationTag = oldTags.flatMap((tag) =>
          tag.startsWith("alchemy:migration-tag:")
            ? [tag.slice("alchemy:migration-tag:".length)]
            : [],
        )[0];
        const newMigrationTag = bumpMigrationTagVersion(oldMigrationTag);

        // Compute delete-class candidates. Candidates are validated against
        // observed namespace ownership below — a class may already have been
        // transferred to another script by its new host's deploy.
        const deletedClassCandidates: string[] = [];
        for (const [logicalId, className] of Object.entries(
          oldDoClassNameByLogicalId,
        )) {
          if (!currentDoClassNameByLogicalId[logicalId]) {
            deletedClassCandidates.push(className);
          }
        }

        // Backward compatibility for old workers that have DO bindings but no
        // alchemy:do tags yet. Cross-script bindings (`scriptName` set to
        // anything other than this worker) are NEVER candidates for
        // delete-class migrations — the class lives on the foreign script
        // and we don't own its lifecycle.
        if (Object.keys(oldDoClassNameByLogicalId).length === 0) {
          for (const oldBinding of oldBindings) {
            const ownedLocally =
              !("scriptName" in oldBinding) || oldBinding.scriptName === name;
            if (
              oldBinding.type === "durable_object_namespace" &&
              "className" in oldBinding &&
              oldBinding.className &&
              ownedLocally &&
              !currentDoBindings.some(
                (binding) => binding.bindingName === oldBinding.name,
              )
            ) {
              deletedClassCandidates.push(oldBinding.className);
            }
          }
        }

        // Class names the current deploy references *cross-script* (mapped to
        // the foreign script). A class that both leaves the "hosted here" set
        // and shows up here has moved to another Worker — Cloudflare rejects
        // deleting a class while any binding in the upload references its
        // class name, and deleting would destroy the namespace's data.
        const crossScriptClassTargets = new Map<string, string>();
        for (const item of metadataBindings) {
          if (
            item.type === "durable_object_namespace" &&
            item.className &&
            typeof item.scriptName === "string" &&
            item.scriptName !== name
          ) {
            crossScriptClassTargets.set(item.className, item.scriptName);
          }
        }

        // One account-level namespace listing serves both sides of a
        // transfer: the destination checks the source still hosts the class
        // before emitting `transferred_classes`, and the former host checks
        // whether a to-be-deleted class was already transferred away.
        // Dispatch-namespace user workers keep the legacy behavior — their
        // namespaces don't surface on the account-level list.
        const mayTransferIn = currentDoBindings.some(
          (binding) =>
            !oldDoClassNameByLogicalId[binding.logicalId] &&
            binding.transferredFrom !== undefined,
        );
        const observedNamespaces =
          !dispatchNamespace &&
          (deletedClassCandidates.length > 0 || mayTransferIn)
            ? yield* listDurableObjectNamespaces(accountId)
            : [];
        const hosts = (
          namespaces: readonly { script: string; class: string }[],
          scriptName: string,
          className: string,
        ) =>
          namespaces.some(
            (ns) => ns.script === scriptName && ns.class === className,
          );
        const scriptHostsClass = (scriptName: string, className: string) =>
          hosts(observedNamespaces, scriptName, className);

        const deletedClasses: string[] = [];
        for (const className of deletedClassCandidates) {
          if (dispatchNamespace) {
            deletedClasses.push(className);
            continue;
          }
          const targetScriptName = crossScriptClassTargets.get(className);
          if (targetScriptName === undefined) {
            // Plain removal. Delete only if the namespace actually still
            // lives here — it may have been transferred to another script by
            // that script's deploy, or removed out-of-band. The stale
            // alchemy:do tag drops out either way because tags are recomputed
            // from current bindings.
            if (scriptHostsClass(name, className)) {
              deletedClasses.push(className);
            }
            continue;
          }
          // The class went local → cross-script. When the new host's deploy
          // ran a `transferred_classes` migration moments ago, the account
          // listing can briefly still attribute the namespace to this script,
          // so re-observe with a short bounded budget until the transfer
          // becomes visible (namespace off this script) or the state is
          // conclusively a conflict (still here — including the case where
          // the target created a *fresh* namespace for the same class name).
          const namespaces = yield* listDurableObjectNamespaces(accountId).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (observed) =>
                !hosts(observed, name, className) ||
                hosts(observed, targetScriptName, className),
              times: 5,
            }),
          );
          if (!hosts(namespaces, name, className)) {
            // Transferred away — nothing to delete.
            continue;
          }
          // local → cross-script transition without a transfer. Fail before
          // any upload: Cloudflare would reject the combined delete + binding
          // anyway, and silently deleting would destroy the namespace's
          // data. See the error's docs for the two ways out
          // (`transferredFrom` on the new host, or a two-phase removal).
          return yield* Effect.fail(
            new DurableObjectTransferRequired({
              scriptName: name,
              className,
              targetScriptName,
            }),
          );
        }

        // Collect container-backed class names so we can send container metadata
        const containerClassNames = new Set(
          bindings.flatMap((b) =>
            (b.data.containers ?? []).map((c) => c.className),
          ),
        );

        // Compute new, renamed, and transferred classes
        const newClasses: string[] = [];
        const newSqliteClasses: string[] = [];
        const renamedClasses: { from: string; to: string }[] = [];
        const transferredClasses: {
          from: string;
          fromScript: string;
          to: string;
        }[] = [];
        for (const binding of currentDoBindings) {
          let previousClassName: string | undefined =
            oldDoClassNameByLogicalId[binding.logicalId];
          if (!previousClassName) {
            // No DO metadata tag maps this logical id to a class — the
            // worker was created outside Alchemy (raw API / Wrangler) or
            // before these tags existed. Fall back to matching the observed
            // cloud binding by binding name so adoption reuses the existing
            // class instead of asking Cloudflare to create one that already
            // exists (which fails the migration). This is the "first deploy
            // must match the existing class name" path; once we write the
            // `alchemy:dos:` tag, subsequent renames are driven by logical id.
            const observed = oldBindings.find(
              (old) =>
                old.type === "durable_object_namespace" &&
                "className" in old &&
                old.className &&
                // Only a *locally-owned* binding proves the class exists on
                // this script. A cross-script binding under the same name —
                // e.g. this worker previously referenced another host's
                // class and now hosts its own — points at a foreign
                // namespace and must not suppress the create migration
                // (Cloudflare rejects a local binding for a class the
                // script isn't configured to implement).
                (!("scriptName" in old) ||
                  old.scriptName === undefined ||
                  old.scriptName === name) &&
                old.name === binding.bindingName,
            );
            if (observed && "className" in observed && observed.className) {
              previousClassName = observed.className;
            }
          }
          if (!previousClassName) {
            // A class new to this script is a host move when the declaration
            // says so: `transferredFrom` lists the former host(s) — moves
            // are always declared, never inferred, because a class deleted
            // on one worker and created on another is otherwise ambiguous
            // between "move the data" and "delete + fresh namespace". The
            // declared source must be observed to still host the namespace;
            // otherwise (fresh stage, transfer already completed) fall
            // through to a plain create.
            const fromScript = dispatchNamespace
              ? undefined
              : yield* resolveTransferSource({
                  accountId,
                  selfScriptName: name,
                  logicalId: binding.logicalId,
                  className: binding.className,
                  sources: normalizeTransferSources(
                    binding.transferredFrom,
                    name,
                  ),
                  observedNamespaces,
                });
            if (fromScript !== undefined) {
              // Data-preserving move: ship Cloudflare's
              // `transferred_classes` migration instead of creating a
              // fresh class.
              transferredClasses.push({
                from: binding.className,
                fromScript,
                to: binding.className,
              });
              continue;
            }
            // Default all new Durable Object classes to SQLite. Cloudflare
            // recommends SQLite for new namespaces, and container-backed
            // Durable Objects require it.
            newSqliteClasses.push(binding.className);
          } else if (previousClassName !== binding.className) {
            renamedClasses.push({
              from: previousClassName,
              to: binding.className,
            });
          }
        }

        yield* Effect.logInfo(
          `Cloudflare Worker put: durable object reconciliation ${JSON.stringify(
            {
              oldDoClassNameByLogicalId,
              currentDoClassNameByLogicalId,
              deletedClasses,
              renamedClasses,
              transferredClasses,
              newSqliteClasses,
            },
          )}`,
        );

        // Pack every DO logical-id→class mapping into as few `alchemy:dos:`
        // tags as possible — one tag per DO blows Cloudflare's 10-tag limit
        // at 7+ bindings (#811).
        const alchemyDoTags = encodeDurableObjectTags(currentDoBindings);

        const alchemyTags = [
          ...createAlchemyWorkerTags(id),
          ...alchemyDoTags,
          ...(newMigrationTag
            ? [`alchemy:migration-tag:${newMigrationTag}`]
            : []),
        ];
        const metadataTags = Array.from(
          new Set([...alchemyTags, ...(news.tags ?? [])]),
        );
        yield* validateWorkerTags(name, metadataTags, alchemyTags.length);

        const migrations = {
          oldTag: oldMigrationTag,
          newTag: newMigrationTag,
          newClasses,
          deletedClasses,
          renamedClasses,
          transferredClasses,
          newSqliteClasses,
        };

        const metadataContainers = [...containerClassNames].map(
          (className) => ({
            className,
          }),
        );

        const compatibility = getCompatibility(news);
        const tailConsumers = resolveTailConsumers(news.tailConsumers);
        const streamingTailConsumers = resolveTailConsumers(
          news.streamingTailConsumers,
        );
        const metadata: workers.PutScriptRequest["metadata"] = {
          assets: metadataAssets,
          bindings: metadataBindings,
          bodyPart: undefined,
          cacheOptions: news.cache ?? getCacheBinding(bindings),
          compatibilityDate: compatibility.date,
          compatibilityFlags: compatibility.flags,
          containers:
            metadataContainers.length > 0 ? metadataContainers : undefined,
          keepAssets,
          keepBindings: undefined,
          limits: news.limits,
          logpush: news.logpush,
          mainModule: bundle.main,
          migrations,
          observability: news.observability ?? {
            enabled: true,
            logs: {
              enabled: true,
              invocationLogs: true,
            },
          },
          placement: news.placement,
          tags: metadataTags,
          tailConsumers,
          streamingTailConsumers,
          usageModel: undefined,
        };
        const rolloutTraffic = getSelfRolloutTraffic(news);
        let versionId: string | undefined;
        let deploymentId: string | undefined;
        let worker: {
          id?: string | null;
          logpush?: boolean | null;
          /** The immutable script id (Cloudflare's script "tag"). */
          tag?: string | null;
        };
        // A gradual rollout (`version.traffic` < 100) deploys through the
        // versions API instead of the full-cutover script PUT. That's only
        // possible when the script already has a live deployment to split
        // traffic against (otherwise the first deploy takes 100%), and only
        // for changes a version can carry — code, bindings, compatibility
        // settings, cache. Script-level settings in the upload metadata
        // (tags, observability, limits, placement, logpush) keep their live
        // values until the next full deploy, matching
        // `wrangler versions upload` semantics.
        if (
          rolloutTraffic !== undefined &&
          existingSettings !== undefined &&
          output?.hash !== undefined &&
          !dispatchNamespace
        ) {
          const migratedClasses = [
            ...migrations.newClasses,
            ...migrations.newSqliteClasses,
            ...migrations.deletedClasses,
            ...migrations.renamedClasses.map((r) => r.to),
            ...migrations.transferredClasses.map((t) => t.to),
          ];
          if (migratedClasses.length > 0) {
            return yield* Effect.fail(
              new WorkerVersionConfigError({
                message: `This deploy of '${name}' changes Durable Object classes (${migratedClasses.join(", ")}), which requires a migration — migrations cannot ride a gradual rollout. Deploy at 100% (remove version.traffic) first, then resume gradual rollouts.`,
              }),
            );
          }
          yield* session.note(
            `Uploading version of ${name} (${bundleSize}) ...`,
          );
          const created = yield* workers
            .createScriptVersion({
              accountId,
              scriptName: name,
              metadata: {
                mainModule: metadata.mainModule!,
                assets: metadata.assets,
                bindings: metadata.bindings,
                keepAssets: metadata.keepAssets,
                compatibilityDate: metadata.compatibilityDate,
                compatibilityFlags: metadata.compatibilityFlags,
                cacheOptions: metadata.cacheOptions,
                annotations:
                  news.version?.alias !== undefined ||
                  news.version?.message !== undefined ||
                  news.version?.tag !== undefined
                    ? {
                        workersAlias: news.version?.alias,
                        workersMessage: news.version?.message,
                        workersTag: news.version?.tag,
                      }
                    : undefined,
              },
              files: bundle.files,
            })
            .pipe(
              Effect.retry({
                while: isBindingTargetNotFound,
                schedule: bindingTargetNotFoundRetrySchedule(),
              }),
            );
          versionId = created.id ?? undefined;
          if (versionId === undefined) {
            return yield* Effect.fail(
              new WorkerVersionConfigError({
                message: `Cloudflare did not return a version id for the uploaded version of '${name}'.`,
              }),
            );
          }
          if (rolloutTraffic > 0) {
            yield* session.note(
              `Deploying version at ${rolloutTraffic}% of traffic ...`,
            );
            deploymentId = yield* deployVersionTraffic({
              accountId,
              scriptName: name,
              versionId,
              traffic: rolloutTraffic,
              message: news.version?.message,
            });
          }
          worker = { id: name, logpush: existingSettings.logpush };
        } else {
          if (rolloutTraffic !== undefined) {
            // First deploy of this script (or a pre-create placeholder is
            // the only thing live) — there is no previous version worth
            // splitting traffic with, so this deploy takes 100%.
            yield* Effect.logInfo(
              `Cloudflare Worker ${name}: no previous live version to split traffic with; deploying at 100%`,
            );
          }
          worker = yield* putWorkerScriptWithMigrationRecovery();
        }

        function putWorkerScriptWithMigrationRecovery() {
          return putWorkerScript({
            accountId,
            scriptName: name,
            dispatchNamespace,
            metadata,
            files: bundle.files,
          }).pipe(
            Effect.catch((err) => {
              // When adopting a Worker managed by Wrangler (or after a previous
              // deploy with mismatched migrations), the old_tag precondition
              // fails. The only way to discover the actual tag is through the
              // error message — getScriptSettings is meant to return it but
              // doesn't at runtime.
              const msg = String(
                typeof err === "object" && err !== null && "message" in err
                  ? err.message
                  : err,
              );
              const expectedTag = msg.match(
                /when expected tag is ['"]?([^'"]+)['"]?/,
              )?.[1];
              if (expectedTag) {
                return putWorkerScript({
                  accountId,
                  scriptName: name,
                  dispatchNamespace,
                  metadata: {
                    ...metadata,
                    migrations: {
                      ...migrations,
                      oldTag: expectedTag,
                      newTag: bumpMigrationTagVersion(expectedTag),
                    },
                  },
                  files: bundle.files,
                });
              }
              // @effect-diagnostics-next-line anyUnknownInErrorContext:off
              return Effect.fail(err as any);
            }),
          );
        }
        const { settings, durableObjectNamespaces } =
          yield* getWorkerSettingsWithDurableObjects(
            name,
            expectedDurableObjectClassNames,
            dispatchNamespace,
          );
        // Workers for Platforms user workers are invoked via dynamic dispatch,
        // never routed directly — they have no workers.dev subdomain, custom
        // domains, zone routes, or cron triggers. Skip all of that
        // reconciliation.
        if (dispatchNamespace) {
          return {
            workerId:
              worker.tag ??
              cachedWorkerId(output?.workerId, name) ??
              (yield* Effect.fail(
                new WorkerIdNotFound({
                  scriptName: name,
                  message: `Cloudflare Worker: the dispatch-namespace upload for '${name}' did not return the script's immutable ID`,
                }),
              )),
            workerName: name,
            namespace: dispatchNamespace,
            logpush: worker.logpush ?? undefined,
            url: undefined,
            tags: settings.tags ?? metadata.tags,
            durableObjectNamespaces,
            accountId,
            urls: [],
            domain: undefined,
            routes: [],
            crons: [],
            tailConsumers:
              settings.tailConsumers?.map((c) => ({ service: c.service })) ??
              tailConsumers,
            // The settings read endpoint doesn't expose
            // `streaming_tail_consumers`; record what this deploy uploaded.
            streamingTailConsumers,
            hash,
          } satisfies Worker["Attributes"];
        }
        // Reconcile the workers.dev settings against observed cloud state.
        // We can't diff `news.workersDev` against `olds.workersDev` here
        // because both default to `undefined` (meaning "enable") — that
        // comparison would skip the API call on every deploy where the user
        // never set the prop, leaving the subdomain in whatever state
        // Cloudflare currently has it (disabled by default, or whatever
        // a previous failed/external action left it as).
        const workersDev = resolveWorkersDev(news.workersDev);
        const observedSubdomain = yield* workers
          .getScriptSubdomain({
            accountId,
            scriptName: name,
          })
          .pipe(
            Effect.orElseSucceed<workers.GetScriptSubdomainResponse>(() => ({
              enabled: false,
              previewsEnabled: false,
            })),
          );
        if (
          workersDev.enabled !== observedSubdomain.enabled ||
          workersDev.previewsEnabled !== observedSubdomain.previewsEnabled
        ) {
          yield* session.note(
            `${workersDev.enabled || workersDev.previewsEnabled ? "Enabling" : "Disabling"} workers.dev subdomain...`,
          );
          // Cloudflare's script registry is eventually consistent — for the
          // first few hundred ms after `putScript` returns, POST /subdomain
          // can still get back `WorkerNotFound` (a generic "unknown error"
          // body), or a bare 500 surfaced as `InternalServerError` /
          // `UnknownCloudflareError` (code 10013). Bigger uploads race harder.
          // Retry the subdomain toggle on those transient tags with a short
          // exponential backoff; same pattern we use elsewhere in this
          // provider for DO-namespace propagation and for `putScript` itself.
          yield* setWorkerSubdomain(name, workersDev).pipe(
            Effect.retry({
              while: (error) =>
                error._tag === "WorkerNotFound" ||
                error._tag === "InternalServerError" ||
                error._tag === "UnknownCloudflareError",
              schedule: Schedule.max([
                Schedule.exponential(200),
                Schedule.recurs(15),
              ]),
            }),
          );
        }
        // Custom domains are managed only when `domain` is declared on props
        // (#942): an omitted `domain` leaves live attachments alone — and
        // spares a plain workers.dev Worker the listDomains call on every
        // deploy (#926) — while `domain: null` explicitly detaches
        // everything. When managed, the canonical name + aliases + redirect
        // hostnames are all attached (DNS + edge certificate); redirect
        // hostnames additionally get a redirect rule, which runs before the
        // Worker so those requests never invoke it. Unmanaged domains
        // persisted in state carry forward so read keeps observing them.
        const manageCustomDomains = news.domain !== undefined;
        const domainConfig = yield* resolveWorkerDomain(news.domain);
        const previousDomain = stateWorkerDomain(output);
        let effectiveDomain = manageCustomDomains
          ? domainConfig
          : previousDomain;
        if (!manageCustomDomains && previousDomain !== undefined) {
          // Unmanaged, but state remembers domains: observe which of them
          // are actually still attached and carry only those forward —
          // stale state entries (e.g. legacy records whose attach never
          // happened, or hostnames detached out-of-band) must not
          // resurface in `urls`. Plain workers.dev Workers (no persisted
          // domains) never pay this listDomains call (#926).
          const live = new Set(
            yield* workers.listDomains({ accountId, service: name }).pipe(
              Effect.map((r) =>
                (r.result ?? []).flatMap((d) =>
                  d.hostname ? [d.hostname] : [],
                ),
              ),
              Effect.catch(() => Effect.succeed([] as string[])),
            ),
          );
          const serving = [
            ...(live.has(previousDomain.name) ? [previousDomain.name] : []),
            ...previousDomain.aliases.filter((h) => live.has(h)),
          ];
          effectiveDomain =
            serving.length > 0
              ? {
                  name: serving[0],
                  aliases: serving.slice(1),
                  redirects: previousDomain.redirects.filter((h) =>
                    live.has(h),
                  ),
                }
              : undefined;
        }
        if (manageCustomDomains) {
          const desiredHostnames = domainConfig
            ? [
                domainConfig.name,
                ...domainConfig.aliases,
                ...domainConfig.redirects,
              ]
            : [];
          yield* session.note(
            `Reconciling custom domains (${desiredHostnames.length}) ...`,
          );
          // Capture hostname → zone for *currently attached* domains before
          // reconcile detaches removed ones — a removed redirect hostname's
          // zone is otherwise unresolvable and its rule couldn't be cleaned.
          const liveBeforeReconcile = yield* workers
            .listDomains({ accountId, service: name })
            .pipe(
              Effect.map((r) =>
                (r.result ?? []).flatMap((d) =>
                  d.hostname && d.zoneId
                    ? [[d.hostname, d.zoneId] as const]
                    : [],
                ),
              ),
              Effect.catch(() => Effect.succeed([])),
            );
          const reconciled = yield* reconcileDomains(
            name,
            desiredHostnames,
            domainConfig?.zone,
          );
          const zoneIdByHostname = new Map([
            ...liveBeforeReconcile,
            ...reconciled.map((d) => [d.hostname, d.zoneId] as const),
          ]);
          yield* reconcileRedirectRules({
            scriptName: name,
            domain: domainConfig,
            zoneIdByHostname,
            previousRedirects: previousDomain?.redirects ?? [],
          });
          effectiveDomain = domainConfig;
        }
        const urls = yield* computeWorkerUrls({
          scriptName: name,
          workersDev,
          domain: effectiveDomain,
          uploadedVersionId: versionId,
          uploadedVersionAlias: news.version?.alias,
        });
        const desiredRoutes = yield* normalizeRoutes(news.routes);
        const previousRoutes = output?.routes ?? [];
        if (desiredRoutes.length > 0 || previousRoutes.length > 0) {
          yield* session.note(
            `Reconciling worker routes (${desiredRoutes.length}) ...`,
          );
        }
        const routes = yield* reconcileRoutes(
          name,
          desiredRoutes,
          previousRoutes,
        );
        // Version-affinity transform rules (`version.affinity`): pin each
        // user to one version during gradual rollouts by filling the
        // version-key header from a stable request property, on every zone
        // this Worker serves on. Runs after the domain/route reconciles so
        // freshly attached surfaces resolve their zones, and also when only
        // *previous* state holds rules, so removing affinity converges.
        const affinity =
          news.version?.parent == null ? news.version?.affinity : undefined;
        const previousAffinityZoneIds = output?.affinityZoneIds ?? [];
        let affinityZoneIds: string[] | undefined;
        if (affinity !== undefined || previousAffinityZoneIds.length > 0) {
          const resolvedAffinity =
            affinity !== undefined
              ? yield* resolveVersionAffinity(affinity)
              : undefined;
          let hostsByZone: Map<string, AffinityZoneHost[]> | undefined;
          if (resolvedAffinity !== undefined) {
            hostsByZone = new Map();
            const addHost = (zoneId: string, host: AffinityZoneHost) => {
              const hosts = hostsByZone!.get(zoneId) ?? [];
              hosts.push(host);
              hostsByZone!.set(zoneId, hosts);
            };
            // Serving hostnames from *observed* domain attachments (covers
            // managed, unmanaged, and adopted domains alike); redirect
            // hostnames 301 before the Worker and never need a key.
            const redirectHosts = new Set(effectiveDomain?.redirects ?? []);
            const attached = yield* workers
              .listDomains({ accountId, service: name })
              .pipe(Effect.map((r) => r.result ?? []));
            for (const d of attached) {
              if (!d.hostname || !d.zoneId || redirectHosts.has(d.hostname)) {
                continue;
              }
              addHost(d.zoneId, { host: d.hostname, wildcard: false });
            }
            for (const route of routes) {
              const host = route.pattern.split("/")[0];
              if (!host || host.includes('"')) continue;
              addHost(route.zoneId, { host, wildcard: host.includes("*") });
            }
            if (hostsByZone.size === 0) {
              return yield* Effect.fail(
                new WorkerVersionConfigError({
                  message:
                    `version.affinity pins users via a zone Transform Rule setting the ${AFFINITY_HEADER} header, which only sees zone traffic — give '${name}' a custom domain (\`domain\`) or zone \`routes\`. ` +
                    `On the bare workers.dev URL, clients must send the header themselves.`,
                }),
              );
            }
            yield* session.note("Reconciling version-affinity rules ...");
          }
          const placed = yield* reconcileAffinityRules({
            scriptName: name,
            desired:
              resolvedAffinity !== undefined && hostsByZone !== undefined
                ? { affinity: resolvedAffinity, hostsByZone }
                : undefined,
            previousZoneIds: previousAffinityZoneIds,
          });
          affinityZoneIds = placed.length > 0 ? placed : undefined;
        }
        const desiredCrons = normalizeCrons([
          ...getCronBindings(bindings),
          ...(news.crons ?? []),
        ]);
        const previousCrons = output?.crons ?? [];
        // Same gating as read: skip getScriptSchedule when neither props nor
        // prior state indicate cron management (#926).
        const crons =
          desiredCrons.length > 0 || previousCrons.length > 0
            ? yield* reconcileCrons(name, desiredCrons, previousCrons, session)
            : [];
        return {
          // The immutable script ID. The gradual-rollout branch deploys via
          // the versions API (no script PUT response), and rows persisted by
          // older releases carried the script *name* here — both fall back
          // to a lazy listing lookup.
          workerId:
            worker.tag ??
            cachedWorkerId(output?.workerId, name) ??
            (yield* findWorkerId(accountId, name)),
          workerName: name,
          namespace: undefined,
          logpush: worker.logpush ?? undefined,
          url: urls[0],
          urls,
          domain: effectiveDomain,
          tags: settings.tags ?? metadata.tags,
          durableObjectNamespaces,
          accountId,
          routes,
          crons,
          // Observed post-upload settings are authoritative: the gradual
          // rollout branch above deploys via the versions API, which leaves
          // script-level settings (tail consumers included) at their live
          // values until the next full deploy.
          tailConsumers:
            settings.tailConsumers?.map((c) => ({ service: c.service })) ??
            tailConsumers,
          // GET script-settings has no `streaming_tail_consumers` field (the
          // API only carries it on upload metadata), so the uploaded value is
          // authoritative here. In the gradual-rollout branch the versions
          // API leaves script-level settings live-as-is, matching how the
          // metadata surface treats every other script-level field.
          streamingTailConsumers,
          versionOf: undefined,
          versionId,
          deploymentId,
          affinityZoneIds,
          hash,
        } satisfies Worker["Attributes"];
      });

      // Compare the desired assets against the deployed asset-content hash.
      //
      // For `AssetsWithHash` (the documented `Command.Build` contract) the
      // upstream build already produced an authoritative hash — compare
      // strings without touching the filesystem. Reading the directory here
      // would crash when the prior state was written on a different machine
      // and the path doesn't exist locally, blocking any local reapply even
      // though the precomputed hash is right there in props.
      //
      // For the plain `string` / `AssetsProps` shapes there is no hash in
      // props, so read + hash the directory exactly like the apply path does
      // (`readAssets`) and compare against the stored content hash — an
      // unchanged tree converges to a noop plan instead of a forever-dirty
      // conservative update. The overall read cost is unchanged: previously
      // every plan reported "changed" and `putWorker` read the tree during
      // apply only to discover nothing changed (`keepAssets`); now the diff
      // reads it and a match skips reconcile entirely. A directory that is
      // missing or invalid at plan time (e.g. produced by an upstream build
      // step that only runs during apply) degrades to "changed" — apply
      // reads it once and either uploads or surfaces the real typed error.
      const assetsChanged = Effect.fn(function* (
        assets: WorkerProps["assets"],
        output: Worker["Attributes"],
      ) {
        if (!assets) {
          return false;
        }
        // An explicitly-undefined `hash` (`{ directory, hash: maybe }`) is
        // the hash-less shape, not a supplied hash — fall through to the
        // directory read instead of comparing undefined forever-dirty.
        if (
          Predicate.hasProperty(assets, "hash") &&
          assets.hash !== undefined
        ) {
          return assets.hash !== output.hash?.assets;
        }
        const read = yield* prepareAssets(assets).pipe(
          Effect.catchTag(
            ["PlatformError", "AssetTooLargeError", "TooManyAssetsError"],
            () => Effect.succeed(undefined),
          ),
        );
        return read === undefined || read.hash !== output.hash?.assets;
      });

      const hasChanged = Effect.fn(function* (
        id: string,
        props: WorkerProps,
        output: Worker["Attributes"],
        bindings: readonly ResourceBinding<Worker["Binding"]>[] | undefined,
        accountId: string,
      ) {
        // #745: metadata-only edits (compatibility, observability, placement,
        // limits, logpush, env literals, bindings, subdomain config, tags)
        // don't touch the bundle/vite/asset-content hashes below, so compare a
        // hash of that surface first. Skipped when bindings are still
        // unresolved: the hash can't be computed deterministically here, and
        // the eventual apply stores it once bindings resolve.
        if (bindings) {
          // For a version worker, `Worker.URL` resolves to the *aliased
          // preview URL* (see `putWorkerVersion`) — recompute the same
          // value here so the metadata hash matches what the apply stored
          // and unchanged deploys stay noops.
          const versionParent =
            props.version?.parent != null
              ? (resolveVersionParentName(props.version) ?? output.versionOf)
              : undefined;
          const selfUrl = hasSelfUrlBinding(bindings)
            ? versionParent !== undefined
              ? yield* Effect.gen(function* () {
                  const alias = yield* resolveVersionAlias(
                    id,
                    props,
                    versionParent,
                  );
                  return alias !== undefined
                    ? `https://${alias}-${versionParent}.${yield* getAccountSubdomain(accountId)}.workers.dev`
                    : undefined;
                })
              : yield* resolveSelfUrl(output.workerName, props, accountId)
            : undefined;
          const metadataHash = yield* resolveWorkerMetadataHash({
            props,
            bindings,
            accountId,
            stack: { name: stack.name, stage: stack.stage },
            selfUrl,
          });
          if (metadataHash !== output.hash?.metadata) {
            return true;
          }
        }
        // External source provider: the source recomputes the hash slots
        // it owns (without building where it can) and any defined slot
        // that differs from state means an update. `additionalWorkspaces`
        // is auxiliary metadata for the input hash, never a change signal.
        if (props.source) {
          const source = yield* resolveSource(props);
          const slots = yield* source.hash(
            makeSourceContext({
              id,
              workerName: output.workerName,
              props,
              compatibility: getCompatibility(props),
              stack: { name: stack.name, stage: stack.stage },
            }),
            output.hash,
          );
          for (const slot of ["bundle", "input", "assets"] as const) {
            if (
              slots[slot] !== undefined &&
              slots[slot] !== output.hash?.[slot]
            ) {
              return true;
            }
          }
          if (source.ownsAssets) {
            // Source-owned assets are covered by the `input` hash.
            return false;
          }
          if (!props.assets) {
            return false;
          }
          const assetsHash = Predicate.hasProperty(props.assets, "hash")
            ? props.assets.hash
            : undefined;
          if (assetsHash === undefined) {
            return true;
          }
          return assetsHash !== output.hash?.assets;
        }
        if (props.script !== undefined) {
          const scriptHash = yield* hashScript(props.script);
          if (scriptHash !== output.hash?.bundle) {
            return true;
          }
          return yield* assetsChanged(props.assets, output);
        }
        if (props.vite) {
          const Vite = yield* loadVite;
          const { hash } = yield* Vite.hashViteInput(
            props.vite.rootDir,
            props.vite.memo,
            Effect.succeed(output.hash?.additionalWorkspaces ?? []),
          );
          return hash !== output.hash?.input;
        }
        // Assets-only Worker — there is no bundle to hash. A stored bundle
        // hash means the Worker previously had a script and is being
        // converted to assets-only, which must deploy.
        if (props.main === undefined) {
          if (output.hash?.bundle !== undefined) {
            return true;
          }
          // No assets either — the config is invalid; report "changed" so
          // the apply runs and surfaces the descriptive error.
          if (!props.assets) {
            return true;
          }
          return yield* assetsChanged(props.assets, output);
        }
        const bundleHash = yield* prepareBundle(id, props).pipe(
          Effect.map((b) => b.hash),
        );
        if (bundleHash !== output.hash?.bundle) {
          return true;
        }
        return yield* assetsChanged(props.assets, output);
      });

      return Worker.Provider.of({
        stables: ["workerId", "workerName"],
        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* yield* CloudflareEnvironment;
            // Account-scoped enumeration of every Worker script. The
            // per-script `read` makes several extra calls (subdomain,
            // settings, domains, schedule) to fully hydrate
            // url/durableObjectNamespaces/domains/crons. Doing that for
            // every script on the account is both expensive (4 calls × N)
            // and fragile — a single script with a binding shape the
            // settings schema doesn't know about would break the whole
            // listing (the same reason `read` deliberately avoids
            // `listScripts`). For `list()` we hydrate the core identifying
            // and settings fields that come straight from the script
            // metadata and leave the binding-derived fields at the same
            // defaults `read` returns when those sub-resources are absent
            // (`url: undefined`, `durableObjectNamespaces: {}`,
            // `domains: []`, `crons: []`). `accountId` + `workerName` are
            // sufficient for `delete`.
            return yield* workers.listScripts.pages({ accountId }).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  // Annotate the element type as the full `Attributes` shape
                  // (incl. the optional `hash`) so it matches `read` exactly.
                  // `list()` is an inference source for the provider's resource
                  // type; a narrower element (e.g. via `satisfies`, which omits
                  // `hash`) would derail `Res` inference and cascade every
                  // lifecycle method's requirement channel to `never`.
                  (page.result ?? []).flatMap(
                    (script): Worker["Attributes"][] =>
                      script.id
                        ? [
                            {
                              accountId,
                              // Practically always present; an empty value
                              // is healed by the per-script read.
                              workerId: script.tag ?? "",
                              workerName: script.id,
                              namespace: undefined,
                              logpush: script.logpush ?? undefined,
                              url: undefined,
                              tags: script.tags ?? undefined,
                              durableObjectNamespaces: {},
                              urls: [],
                              domain: undefined,
                              routes: [],
                              crons: [],
                            },
                          ]
                        : [],
                  ),
                ),
              ),
            );
          }),
        diff: Effect.fn(function* ({
          id,
          news: desired,
          olds,
          output,
          newBindings,
        }) {
          const { accountId } = yield* yield* CloudflareEnvironment;
          // Effect-valued `env` entries (tagged Worker classes / resource
          // Effects — the circular-bindings pattern) never resolve at plan
          // time and are dropped from persisted props by `stripUnresolved`
          // at the commit boundary. Their deploy-time identity is carried by
          // the resolved binding data, which the metadata hash below covers.
          // Strip them before the resolution check so a tag in `env` doesn't
          // force the raw-props fallback — which compares the Effect's JSON
          // form against the stripped stored props and re-plans an update
          // forever (#874).
          const news = stripEffects(desired);
          if (!isResolved(news)) return undefined;
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" };
          }
          // An account-level script and a dispatch-namespace ("user worker")
          // script are distinct cloud resources; moving a Worker into, out of,
          // or between namespaces requires a replacement.
          const newNamespace = resolveNamespaceName(news.namespace);
          const oldNamespace =
            output?.namespace ?? resolveNamespaceName(olds?.namespace);
          if (newNamespace !== oldNamespace) {
            return { action: "replace" };
          }
          // A version worker (version.parent) and a script-owning Worker are
          // distinct cloud resources, and a version belongs to exactly one
          // parent script — switching mode or parent is a replacement.
          const newIsVersion = news.version?.parent != null;
          const oldIsVersion =
            output?.versionOf !== undefined || olds?.version?.parent != null;
          if (newIsVersion !== oldIsVersion) {
            return { action: "replace" };
          }
          if (newIsVersion) {
            const newParent = resolveVersionParentName(news.version);
            const oldParent =
              output?.versionOf ?? resolveVersionParentName(olds?.version);
            if (
              newParent !== undefined &&
              oldParent !== undefined &&
              newParent !== oldParent
            ) {
              return { action: "replace" };
            }
          }
          const oldWorkerName =
            output?.workerName ?? (yield* createWorkerName(id, olds?.name));
          // Auto-generated names are engine-owned: the deployed name stays
          // authoritative even if the generator would name this id
          // differently today (a Worker replace would also destroy its
          // Durable Object storage). Only an explicit user-provided name
          // can force a replace.
          const workerName = news.name ?? oldWorkerName;
          if (workerName !== oldWorkerName) {
            return { action: "replace" };
          }
          if (!output) {
            return;
          }
          // Compare the full domain config — name, aliases (ordered: they
          // drive `urls` order), and redirects — against persisted state
          // (with legacy `domains`-list state migrated on the fly).
          const newDomainConfig = yield* resolveWorkerDomain(news.domain);
          const oldDomainConfig = stateWorkerDomain(output);
          const domainKey = (d: ResolvedWorkerDomain | undefined) =>
            d === undefined
              ? ""
              : JSON.stringify([
                  d.name,
                  d.aliases,
                  [...d.redirects].sort(),
                  d.zone ?? null,
                ]);
          // An omitted `domain` unmanages the surface (#942): reconcile
          // carries previously-observed custom domains forward in state, so
          // comparing the empty desired config against those would report a
          // dirty plan on every deploy, forever. Only a declared `domain`
          // (including `null`, the explicit detach-all) participates.
          const domainsChanged =
            news.domain !== undefined &&
            domainKey(newDomainConfig) !== domainKey(oldDomainConfig);
          const newCrons = normalizeCrons([
            ...(Array.isArray(newBindings)
              ? getCronBindings(
                  newBindings as ResourceBinding<Worker["Binding"]>[],
                )
              : []),
            ...(news.crons ?? []),
          ]).sort();
          const oldCrons = [...(output?.crons ?? [])].sort();
          const cronsChanged =
            newCrons.length !== oldCrons.length ||
            newCrons.some((cron, index) => cron !== oldCrons[index]);
          const newRouteKeys = (yield* normalizeRoutes(news.routes))
            .map(routeKey)
            .sort();
          const oldRouteKeys = (output?.routes ?? []).map(routeKey).sort();
          const routesChanged =
            newRouteKeys.length !== oldRouteKeys.length ||
            newRouteKeys.some((key, index) => key !== oldRouteKeys[index]);
          // `url` is `urls[0]`: the canonical custom domain when one is
          // configured (or carried forward from state when the surface is
          // unmanaged, #942/#975), else the stable workers.dev URL. It's
          // stable across this update exactly when the recomputed value
          // matches what's deployed. Carry it forward as a stable only
          // then, so downstream resources that reference `worker.url`
          // (e.g. a GitHub Webhook delivery URL built via
          // `Output.interpolate`) resolve it to a concrete value during
          // planning instead of an unresolved Output — otherwise every
          // worker update spuriously re-updates them. Previews-only mode
          // and version workers derive `url` from version preview URLs —
          // never assumed stable here.
          const newWorkersDev = resolveWorkersDev(news.workersDev);
          const effectiveDomainConfig =
            news.domain !== undefined ? newDomainConfig : oldDomainConfig;
          const newUrl = newIsVersion
            ? undefined
            : effectiveDomainConfig !== undefined
              ? `https://${effectiveDomainConfig.name}`
              : newWorkersDev.enabled
                ? (output.urls ?? []).find(
                    (u) =>
                      isWorkersDevHostname(urlHostname(u)) &&
                      urlHostname(u).startsWith(`${workerName}.`),
                  )
                : undefined;
          const urlStable = newUrl !== undefined && newUrl === output.url;
          // `durableObjectNamespaces` maps each hosted DO class name to the
          // namespace id Cloudflare assigned it. Those ids are permanent for
          // the lifetime of a (worker, class) pair, so the map only changes
          // when a class is added or removed — never on a plain code/config
          // update. Carry it forward as a stable whenever the set of local DO
          // class names is unchanged, for the same reason as `url` above:
          // downstream resources that bind a DO namespace via
          // `worker.durableObjectNamespaces[name]` (e.g. a Container attached
          // to a DO) must resolve it to a concrete value during planning.
          // Otherwise the binding holds an unresolved Output, which
          // `diffBindings` treats as "changed", spuriously re-updating the
          // bound resource on every deploy. Class names are structural (not the
          // namespace id), so this comparison holds even when `newBindings` is
          // otherwise unresolved.
          const newDoClassNames = Array.isArray(newBindings)
            ? getExpectedDurableObjectClassNames(
                (newBindings as ResourceBinding<Worker["Binding"]>[]).flatMap(
                  (b) => b.data.bindings ?? [],
                ),
                workerName,
              ).sort()
            : [];
          const oldDoClassNames = Object.keys(
            output.durableObjectNamespaces ?? {},
          ).sort();
          const doNamespacesStable =
            oldWorkerName === workerName &&
            newDoClassNames.length === oldDoClassNames.length &&
            newDoClassNames.every((name, i) => name === oldDoClassNames[i]);
          // Rows persisted by older releases carried the script *name* in
          // `workerId` (interrupted precreates a provisional ""). Plan one
          // update even when nothing else changed, so reconcile re-records
          // the immutable Worker ID.
          const legacyWorkerId =
            cachedWorkerId(output.workerId, output.workerName) === undefined;
          if (
            legacyWorkerId ||
            domainsChanged ||
            routesChanged ||
            cronsChanged ||
            (yield* hasChanged(
              id,
              news,
              output,
              Array.isArray(newBindings)
                ? (newBindings as ResourceBinding<Worker["Binding"]>[])
                : undefined,
              accountId,
            ))
          ) {
            // The immutable script ID is always stable across an update —
            // except the healing update above, where its value is about to
            // change from the legacy shape to the real ID (downstream
            // consumers must see the fresh value).
            const stables: string[] = legacyWorkerId ? [] : ["workerId"];
            if (oldWorkerName === workerName) {
              stables.push("workerName");
            }
            if (urlStable) {
              stables.push("url");
            }
            if (doNamespacesStable) {
              stables.push("durableObjectNamespaces");
            }
            return {
              action: "update",
              stables: stables.length > 0 ? stables : undefined,
            };
          }
          // Machine-local source paths and resource-backed `env` values have
          // already been compared by their content hashes and canonical
          // binding data. Ignore those representations in the raw fallback so
          // checkout paths and resource attribute projections do not force
          // perpetual updates (#745).
          if (Array.isArray(newBindings)) {
            const normalizeComparedProps = (props: WorkerProps) => {
              const { env: _env, ...rest } = props;
              return {
                ...rest,
                ...(props.main !== undefined
                  ? { main: "<source>" }
                  : undefined),
                ...(props.assets
                  ? {
                      assets: {
                        ...(typeof props.assets === "string"
                          ? undefined
                          : props.assets),
                        directory: "<source>",
                      },
                    }
                  : undefined),
                ...(props.vite
                  ? { vite: { ...props.vite, rootDir: "<source>" } }
                  : undefined),
              };
            };
            if (
              olds !== undefined &&
              !havePropsChanged(
                normalizeComparedProps(olds),
                normalizeComparedProps(news),
              )
            ) {
              return { action: "noop" };
            }
          }
        }),
        precreate: Effect.fn(function* ({ id, news, session, bindings }) {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const name = yield* createWorkerName(id, news.name);
          // A version worker uploads to its parent's script during
          // reconcile; pre-creating a placeholder script under this
          // resource's own generated name would leave a stray script behind.
          // Version workers can't host Durable Object / Workflow classes, so
          // no placeholder is needed for circular bindings either. (`news`
          // is raw here — `version.parent` may be an unresolved ref, but its
          // *presence* is statically known.)
          if (news.version?.parent != null) {
            yield* Effect.logInfo(
              `Cloudflare Worker precreate: skipping stub for version worker ${id}`,
            );
            return {
              // Provisional: a version worker resolves its parent's
              // immutable ID at reconcile — nothing observes this stub row
              // (version workers have no circular bindings).
              workerId: "",
              workerName: name,
              namespace: undefined,
              logpush: undefined,
              url: undefined,
              tags: undefined,
              durableObjectNamespaces: {},
              accountId,
              urls: [],
              domain: undefined,
              routes: [],
              crons: [],
            } satisfies Worker["Attributes"];
          }
          // A Workers for Platforms user worker can't be pre-created: precreate
          // runs on raw, *unresolved* props (so resources in a dependency cycle
          // can signal early), meaning a `namespace` that references the
          // namespace resource is still an unresolved Output here, and the
          // namespace itself may not be deployed yet. There's also nothing to
          // pre-create — a user worker is dispatched to by name, never bound to
          // circularly. Return a stub; `reconcile` performs the real upload
          // once props resolve and the namespace exists.
          if (news.namespace != null) {
            yield* Effect.logInfo(
              `Cloudflare Worker precreate: skipping stub for dispatch-namespace worker ${name}`,
            );
            return {
              // Provisional: reconcile records the real immutable ID from
              // the dispatch upload — nothing observes this stub row (user
              // workers are dispatched by name, never bound circularly).
              workerId: "",
              workerName: name,
              namespace:
                typeof news.namespace === "string" ? news.namespace : undefined,
              logpush: undefined,
              url: undefined,
              tags: undefined,
              durableObjectNamespaces: {},
              accountId,
              urls: [],
              domain: undefined,
              routes: [],
              crons: [],
            } satisfies Worker["Attributes"];
          }
          const dispatchNamespace = resolveNamespaceName(news.namespace);
          const exportMap = news.exports ?? {};
          // A worker hosts Durable Object classes from two independent sources:
          // Effect-native DO *exports* (classes defined in the worker entry) and
          // DO *bindings* declared in `env` — e.g. a bare `Cloudflare.DurableObject`
          // that fronts a Container image. The placeholder must declare *every*
          // hosted class so each namespace is created here. A class that exists
          // only as a binding (a container-fronted DO) is otherwise absent from
          // this stub, and a resource caught in a worker<->container dependency
          // cycle — which resolves `worker.durableObjectNamespaces[className]`
          // against the precreate stub rather than the final reconcile output —
          // fails because the namespace id it needs never surfaced.
          const exportDerived = Object.keys(exportMap)
            .filter((logicalId) => isDurableObjectExport(exportMap[logicalId]))
            .map((logicalId) => ({ logicalId, className: logicalId }));
          // Transfer-destination classes are excluded from the placeholder
          // entirely (class list, bindings, tags): Cloudflare forbids
          // creating the destination class of a `transferred_classes`
          // migration ahead of the transfer, so `reconcile` must perform it
          // with the real upload. (`transferredFrom` may still be an
          // unresolved Output here — precreate runs on raw props — but only
          // its presence matters.)
          const durableObjects = mergeDurableObjectClasses(
            exportDerived,
            getDurableObjectBindings(bindings, name),
          ).filter((binding) => !binding.transferredFrom);
          const doClasses = durableObjects.map((binding) => binding.className);
          // Only attach container metadata for classes actually fronted by a
          // Container binding (mirrors reconcile's `containerClassNames`).
          // Mapping every DO class to a container would wrongly mark plain DOs
          // as container-backed in the placeholder.
          const containers = Array.from(
            new Set(
              bindings.flatMap((b) =>
                (b.data.containers ?? []).map((c) => c.className),
              ),
            ),
          ).map((className) => ({ className }));
          const alchemyDoTags = encodeDurableObjectTags(durableObjects);
          const alchemyTags = [
            ...createAlchemyWorkerTags(id),
            ...alchemyDoTags,
          ];
          const tags = Array.from(
            new Set([...alchemyTags, ...(news.tags ?? [])]),
          );
          yield* validateWorkerTags(name, tags, alchemyTags.length);
          yield* Effect.logInfo(
            `Cloudflare Worker precreate: starting ${name}`,
          );
          yield* Effect.logInfo(
            `Cloudflare Worker precreate: durable objects ${JSON.stringify(
              durableObjects,
            )}`,
          );
          const existingSettings = yield* getScriptSettings(
            accountId,
            name,
            dispatchNamespace,
          ).pipe(
            // A freshly pre-created stub can briefly report "has no
            // versions" before its first version registers — treat it the
            // same as a missing worker (nothing to adopt yet). For a user
            // worker the dispatch-namespace endpoints report a missing
            // script as `DispatchNamespaceScriptNotFound` (and a missing
            // namespace as `DispatchNamespaceNotFound`).
            Effect.catchTag("WorkerNotFound", () => Effect.succeed(undefined)),
            Effect.catchTag("WorkerHasNoVersions", () =>
              Effect.succeed(undefined),
            ),
            Effect.catchTag("DispatchNamespaceScriptNotFound", () =>
              Effect.succeed(undefined),
            ),
            Effect.catchTag("DispatchNamespaceNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
          let durableObjectNamespaces = getDurableObjects(
            existingSettings?.bindings,
          );

          let placeholder: { tag?: string | null } | undefined;
          if (existingSettings) {
            // Engine has already cleared this resource for write via
            // `read` + AdoptPolicy. Either we own it (matching tags) or
            // the user opted in to a takeover (`--adopt` / `adopt(true)`).
            yield* Effect.logInfo(
              `Cloudflare Worker precreate: reusing existing ${name}`,
            );
          } else {
            yield* session.note("Pre-creating worker...");
            const compatibility = getCompatibility(news);
            const mainModule = "main.js";
            const placeholderScript = `${doClasses.length > 0 ? 'import { DurableObject } from "cloudflare:workers";\n\n' : ""}export default { fetch() { return new Response("Alchemy worker is being deployed...") } };\n${doClasses
              .map(
                (className) =>
                  `export class ${className} extends DurableObject {}`,
              )
              .join("\n")}`;
            placeholder = yield* putWorkerScript({
              accountId,
              scriptName: name,
              dispatchNamespace,
              metadata: {
                mainModule,
                bindings:
                  doClasses.length > 0
                    ? doClasses.map((className) => ({
                        type: "durable_object_namespace" as const,
                        name: className,
                        className,
                      }))
                    : undefined,
                // Spreading `getCompatibility` here would set `date`/`flags`,
                // which are not metadata keys — the placeholder would upload
                // with no compatibility date or flags at all.
                compatibilityDate: compatibility.date,
                compatibilityFlags: compatibility.flags,
                containers,
                migrations:
                  doClasses.length > 0
                    ? {
                        oldTag: undefined,
                        newTag: undefined,
                        newClasses: [],
                        deletedClasses: [],
                        renamedClasses: [],
                        transferredClasses: [],
                        newSqliteClasses: doClasses,
                      }
                    : undefined,
                observability: news.observability ?? {
                  enabled: true,
                  logs: {
                    enabled: true,
                    invocationLogs: true,
                  },
                },
                tags,
              },
              files: [
                new File([placeholderScript], mainModule, {
                  type: "application/javascript+module",
                }),
              ],
            }).pipe(
              // Cloudflare's PUT /workers/scripts/{name} intermittently
              // returns code 10002 / "An unknown error has occurred" on the
              // first put for a fresh worker name. Surfaced as the shared
              // `InternalServerError` upstream (alchemy-run/distilled#290).
              // Also match `UnknownCloudflareError` for older
              // @distilled.cloud/cloudflare versions that haven't picked
              // up the patch yet.
              Effect.retry({
                while: (e) =>
                  e._tag === "InternalServerError" ||
                  e._tag === "UnknownCloudflareError",
                schedule: Schedule.max([
                  Schedule.exponential(1000),
                  Schedule.recurs(5),
                ]),
              }),
            );
            if (doClasses.length > 0) {
              ({ durableObjectNamespaces } =
                yield* getWorkerSettingsWithDurableObjects(
                  name,
                  doClasses,
                  dispatchNamespace,
                ));
            }
          }

          if (existingSettings && doClasses.length > 0) {
            ({ durableObjectNamespaces } =
              yield* getWorkerSettingsWithDurableObjects(
                name,
                doClasses,
                dispatchNamespace,
              ));
          }

          return {
            // The placeholder upload's tag (or, when adopting an existing
            // script, the listing lookup); reconcile re-records it after
            // the full deploy.
            workerId:
              placeholder?.tag ?? (yield* findWorkerId(accountId, name)),
            workerName: name,
            namespace: dispatchNamespace,
            logpush: existingSettings?.logpush ?? undefined,
            url: undefined,
            tags: existingSettings?.tags ?? tags,
            durableObjectNamespaces,
            accountId,
            urls: [],
            domain: undefined,
            routes: [],
            crons: [],
          } satisfies Worker["Attributes"];
        }),
        read: Effect.fn(
          function* ({ id, output, olds }) {
            const { accountId } = yield* yield* CloudflareEnvironment;
            // Version workers don't own a script — their `workerName` is the
            // *parent's* script, so the normal read below would hydrate (and
            // potentially brand as adoptable) a resource we don't own. The
            // version itself is immutable; all we verify is that it still
            // exists on the parent.
            if (
              output?.versionOf !== undefined ||
              olds?.version?.parent != null
            ) {
              if (output?.versionOf === undefined || !output.versionId) {
                // No recorded version (e.g. state was written before the
                // upload completed) — nothing to observe; reconcile will
                // upload a fresh version.
                return undefined;
              }
              return yield* workers
                .getScriptVersion({
                  accountId,
                  scriptName: output.versionOf,
                  versionId: output.versionId,
                })
                .pipe(
                  Effect.map(() => output),
                  Effect.catchTag(["WorkerNotFound", "VersionNotFound"], () =>
                    Effect.succeed(undefined),
                  ),
                );
            }
            const workerName =
              output?.workerName ?? (yield* createWorkerName(id, olds?.name));
            const dispatchNamespace =
              output?.namespace ?? resolveNamespaceName(olds?.namespace);
            yield* Effect.logInfo(
              `Cloudflare Worker read: checking ${workerName}`,
            );

            // Workers for Platforms user workers have no subdomain, custom
            // domains, or cron triggers — read only the script settings from
            // the dispatch-namespace endpoint.
            if (dispatchNamespace) {
              const settings = yield* getScriptSettings(
                accountId,
                workerName,
                dispatchNamespace,
              );
              yield* Effect.logInfo(
                `Cloudflare Worker read: found ${workerName} in dispatch namespace ${dispatchNamespace}`,
              );
              const attrs = {
                accountId,
                // Rows persisted by older releases carried the script name
                // here — treat those as unknown and fetch the real ID from
                // the dispatch-namespace script endpoint.
                workerId:
                  cachedWorkerId(output?.workerId, workerName) ??
                  (yield* wfp
                    .getDispatchNamespaceScript({
                      accountId,
                      dispatchNamespace,
                      scriptName: workerName,
                    })
                    .pipe(
                      Effect.flatMap((r) =>
                        r.script?.tag != null
                          ? Effect.succeed(r.script.tag)
                          : Effect.fail(
                              new WorkerIdNotFound({
                                scriptName: workerName,
                                message: `Cloudflare Worker: dispatch-namespace script '${workerName}' has no immutable ID in its metadata`,
                              }),
                            ),
                      ),
                    )),
                workerName,
                namespace: dispatchNamespace,
                logpush: settings.logpush ?? undefined,
                url: undefined,
                tags: settings.tags ?? undefined,
                durableObjectNamespaces: getDurableObjects(settings.bindings),
                urls: [],
                domain: undefined,
                routes: [],
                crons: [],
                tailConsumers: settings.tailConsumers?.map((c) => ({
                  service: c.service,
                })),
                // Not observable: GET script-settings has no
                // `streaming_tail_consumers` field. Carry the last deployed
                // value forward like other provider-managed caches.
                streamingTailConsumers: output?.streamingTailConsumers,
              } satisfies Worker["Attributes"];
              return hasAlchemyWorkerTags(id, settings.tags ?? [])
                ? attrs
                : Unowned(attrs);
            }

            // We deliberately don't call `listScripts({ accountId })` here:
            // it pulls every Worker on the account back through a strict
            // schema decode, and a single existing Worker the schema doesn't
            // know about (e.g. `placement_mode: "targeted"`) breaks the
            // entire read. `getScriptSettings` already fails with
            // `WorkerNotFound` if the script doesn't exist, which the
            // surrounding `Effect.catchTag` turns into `undefined` — that's
            // all the existence check we need.
            //
            // Domain / route / cron observation is gated on whether Alchemy
            // manages that surface for this Worker (#926). A plain workers.dev
            // Worker otherwise pays for listDomains + zone route listings +
            // getScriptSchedule on every plan/deploy read. Route observation
            // is additionally scoped to the zones state already associates
            // with this Worker — see readWorkerRoutes. Empty-array props
            // (`domain: []`, `routes: []`, `crons: []`) still observe so we
            // can detect drift and converge deletions.
            const observeDomains = shouldObserveWorkerDomains(olds, output);
            const observeRoutes = shouldObserveWorkerRoutes(olds, output);
            const observeCrons = shouldObserveWorkerCrons(olds, output);
            const [subdomain, settings, domainsList, routesList] =
              yield* Effect.all(
                [
                  workers.getScriptSubdomain({
                    accountId,
                    scriptName: workerName,
                  }),
                  workers.getScriptScriptAndVersionSetting({
                    accountId,
                    scriptName: workerName,
                  }),
                  observeDomains
                    ? workers
                        .listDomains({
                          accountId,
                          service: workerName,
                        })
                        .pipe(Effect.map((r) => r.result ?? []))
                    : Effect.succeed(
                        [] as workers.ListDomainsResponse["result"],
                      ),
                  observeRoutes
                    ? readWorkerRoutes(workerName, output?.routes)
                    : Effect.succeed([] as Worker["Attributes"]["routes"]),
                ],
                // Bound concurrency so a single Worker read doesn't stampede
                // the account alongside every other Worker's lifecycle calls.
                { concurrency: 1 },
              );
            // Classify the observed hostnames using the declared config
            // (`olds.domain`): the canonical name and each alias/redirect
            // keep their declared role while still attached; drift (attached
            // hostnames we don't know about) is appended to the aliases. The
            // Cloudflare API returns domains in non-deterministic order, so
            // the declared order is what keeps `url`/`urls` from flipping
            // between reads.
            const declared = yield* resolveWorkerDomain(olds?.domain).pipe(
              Effect.orElseSucceed(() => undefined),
            );
            const observed = new Set(
              domainsList.flatMap((d) => (d.hostname ? [d.hostname] : [])),
            );
            const keptName =
              declared !== undefined && observed.has(declared.name)
                ? declared.name
                : undefined;
            const keptAliases =
              declared?.aliases.filter((h) => observed.has(h)) ?? [];
            const keptRedirects =
              declared?.redirects.filter((h) => observed.has(h)) ?? [];
            const classified = new Set([
              ...(keptName ? [keptName] : []),
              ...keptAliases,
              ...keptRedirects,
            ]);
            const drift = [...observed].filter((h) => !classified.has(h));
            const serving = [
              ...(keptName ? [keptName] : []),
              ...keptAliases,
              ...drift,
            ];
            const observedDomain =
              serving.length > 0
                ? {
                    name: serving[0],
                    aliases: serving.slice(1),
                    redirects: keptRedirects,
                  }
                : undefined;
            const urls = [
              ...serving.map((h) => `https://${h}`),
              ...(subdomain.enabled
                ? [
                    `https://${workerName}.${yield* getAccountSubdomain(accountId)}.workers.dev`,
                  ]
                : []),
            ];
            const crons = observeCrons ? yield* getWorkerCrons(workerName) : [];
            yield* Effect.logInfo(
              `Cloudflare Worker read: found ${workerName}`,
            );
            const attrs = {
              accountId,
              // The settings endpoint doesn't expose the immutable ID;
              // reuse the cached value, falling back to a lazy listing
              // lookup for unknown/legacy rows (older releases persisted
              // the script *name* here) so adoption records the real ID.
              workerId:
                cachedWorkerId(output?.workerId, workerName) ??
                (yield* findWorkerId(accountId, workerName)),
              workerName,
              namespace: undefined,
              logpush: settings.logpush ?? undefined,
              url: urls[0],
              urls,
              domain: observedDomain,
              tags: settings.tags ?? undefined,
              durableObjectNamespaces: getDurableObjects(settings.bindings),
              routes: routesList,
              crons,
              tailConsumers: settings.tailConsumers?.map((c) => ({
                service: c.service,
              })),
              // Not observable: GET script-settings has no
              // `streaming_tail_consumers` field. Carry the last deployed
              // value forward like other provider-managed caches.
              streamingTailConsumers: output?.streamingTailConsumers,
              // Rule placement is provider-managed state, not observed here
              // (a getPhas call per known zone on every read); carry the
              // cleanup list forward like any other stable cache.
              affinityZoneIds: output?.affinityZoneIds,
            } satisfies Worker["Attributes"];

            // Centralized ownership decision: the engine routes `read`'s
            // return value based on `AdoptPolicy`. We hand it the attrs
            // either as-is (owned: alchemy tags identify this stack/stage/id,
            // safe to silently adopt even without `--adopt`) or branded with
            // `Unowned` (caller must opt in via `--adopt` or the engine
            // raises `OwnedBySomeoneElse`).
            return hasAlchemyWorkerTags(id, settings.tags ?? [])
              ? attrs
              : Unowned(attrs);
          },
          (effect) =>
            effect.pipe(
              // A worker that exists but hasn't registered a version yet reads
              // as "not deployed" — fall through to (re)create like NotFound.
              // The dispatch-namespace endpoints report the same conditions as
              // `DispatchNamespaceScriptNotFound` / `DispatchNamespaceNotFound`.
              Effect.catchTag("WorkerNotFound", () =>
                Effect.succeed(undefined),
              ),
              Effect.catchTag("WorkerHasNoVersions", () =>
                Effect.succeed(undefined),
              ),
              Effect.catchTag("DispatchNamespaceScriptNotFound", () =>
                Effect.succeed(undefined),
              ),
              Effect.catchTag("DispatchNamespaceNotFound", () =>
                Effect.succeed(undefined),
              ),
            ),
        ),
        reconcile: Effect.fn(function* ({
          id,
          news,
          olds,
          bindings,
          output,
          session,
        }) {
          // A version worker uploads an immutable version to its parent's
          // script instead of owning a script of its own — none of the
          // script-level observation below applies.
          if (news.version?.parent != null) {
            return yield* putWorkerVersion(id, news, bindings, session, output);
          }
          const { accountId } = yield* yield* CloudflareEnvironment;
          const name =
            output?.workerName ?? (yield* createWorkerName(id, news.name));
          const durableObjects = getDurableObjectBindings(bindings, name).map(
            ({ logicalId, className }) => ({
              logicalId,
              className,
            }),
          );
          yield* Effect.logInfo(
            `Cloudflare Worker reconcile: starting ${name}`,
          );
          yield* Effect.logInfo(
            `Cloudflare Worker reconcile: durable objects ${JSON.stringify(
              durableObjects,
            )}`,
          );

          const dispatchNamespace = resolveNamespaceName(news.namespace);
          // Observe — fetch the script's current settings if it already exists.
          // `putWorker` is a true upsert against the Cloudflare API; the
          // existing settings inform asset/migration decisions and let the
          // reconciler converge whether the worker is brand-new, adopted, or
          // an in-place update.
          const existingSettings = yield* getScriptSettings(
            accountId,
            name,
            dispatchNamespace,
          ).pipe(
            // After a pre-create stub (or under a busy account right after
            // the first upload) the settings read can race the script
            // registry and 404 with "has no versions". Treat it as "no
            // existing settings" so reconcile proceeds to upload/converge.
            // The dispatch-namespace endpoints raise
            // `DispatchNamespaceScriptNotFound` / `DispatchNamespaceNotFound`.
            Effect.catchTag("WorkerNotFound", () => Effect.succeed(undefined)),
            Effect.catchTag("WorkerHasNoVersions", () =>
              Effect.succeed(undefined),
            ),
            Effect.catchTag("DispatchNamespaceScriptNotFound", () =>
              Effect.succeed(undefined),
            ),
            Effect.catchTag("DispatchNamespaceNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
          yield* Effect.logInfo(
            `Cloudflare Worker reconcile: existing durable object tags ${JSON.stringify(
              (existingSettings?.tags ?? []).filter(isDurableObjectTag),
            )}`,
          );
          yield* Effect.logInfo(
            `Cloudflare Worker reconcile: previous durable object tags ${JSON.stringify(
              (output?.tags ?? []).filter(isDurableObjectTag),
            )}`,
          );

          return yield* putWorker(
            id,
            news,
            bindings,
            olds,
            output,
            session,
            existingSettings,
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          // Version workers own a version, not the script — `workerName` is
          // the *parent's* script and must never be deleted here. Versions
          // can't be deleted through the API (they age out of Cloudflare's
          // retention window); all we clean up is live traffic: if the
          // current deployment routes traffic to our version, restore 100%
          // to the other version in the split.
          if (output.versionOf !== undefined) {
            // Remove our affinity rules from the parent's zones — the
            // canary owned them, and with the canary gone there is no
            // split left to pin. Best-effort: a zone we can no longer
            // touch must not fail the destroy.
            if (output.affinityZoneIds?.length) {
              yield* reconcileAffinityRules({
                scriptName: output.versionOf,
                desired: undefined,
                previousZoneIds: output.affinityZoneIds,
              }).pipe(Effect.catch(() => Effect.void));
            }
            if (!output.versionId) return;
            yield* Effect.logInfo(
              `Cloudflare Worker delete: releasing version ${output.versionId} of ${output.versionOf}`,
            );
            const { deployments } = yield* workers
              .listScriptDeployments({
                accountId: output.accountId,
                scriptName: output.versionOf,
              })
              .pipe(
                Effect.catchTag("WorkerNotFound", () =>
                  Effect.succeed({
                    deployments:
                      [] as workers.ListScriptDeploymentsResponse["deployments"],
                  }),
                ),
              );
            const latest = deployments[0];
            if (
              !latest?.versions.some((v) => v.versionId === output.versionId)
            ) {
              // Not part of the live deployment — the version just ages out.
              return;
            }
            const stable = latest.versions
              .filter((v) => v.versionId !== output.versionId)
              .sort((a, b) => b.percentage - a.percentage)[0];
            if (!stable) {
              // Our version holds 100% of traffic; there is no other version
              // to restore. Deleting the resource must not take the parent's
              // script down — leave the deployment in place.
              yield* Effect.logWarning(
                `Cloudflare Worker delete: version ${output.versionId} serves 100% of '${output.versionOf}' traffic; leaving the deployment as-is. Re-deploy the parent to move off it.`,
              );
              return;
            }
            yield* workers
              .createScriptDeployment({
                accountId: output.accountId,
                scriptName: output.versionOf,
                strategy: "percentage",
                versions: [{ versionId: stable.versionId, percentage: 100 }],
              })
              .pipe(Effect.catchTag("WorkerNotFound", () => Effect.void));
            return;
          }
          yield* Effect.logInfo(
            `Cloudflare Worker delete: deleting ${output.workerName}`,
          );
          // Workers for Platforms user workers have no custom domains; delete
          // the script straight out of its dispatch namespace.
          if (output.namespace) {
            yield* deleteWorkerScript(
              output.accountId,
              output.workerName,
              output.namespace,
            ).pipe(
              Effect.catchTag(
                [
                  "DispatchNamespaceScriptNotFound",
                  "DispatchNamespaceNotFound",
                ],
                () => Effect.void,
              ),
            );
            return;
          }
          // Look up live domain IDs rather than trusting persisted state.
          // We no longer track `{ id, zoneId }` on the output; fetching
          // straight from Cloudflare handles both the normal case and
          // adopted workers whose domains we never recorded.
          const liveDomains = yield* workers
            .listDomains({
              accountId: output.accountId,
              service: output.workerName,
            })
            .pipe(
              Effect.map((r) => r.result ?? []),
              Effect.catch(() => Effect.succeed([])),
            );
          // Remove our redirect rules from each affected zone's dynamic
          // redirect entrypoint *before* detaching the domains — the live
          // domain list is what resolves each redirect hostname's zone.
          // Reconciling with an empty domain config removes exactly the
          // rules tagged `alchemy:worker:<script>:redirect:*`, leaving
          // everything else in the shared entrypoint untouched.
          // Remove our version-affinity rules from every zone state says
          // holds them. Best-effort, like the redirect rules below.
          if (output.affinityZoneIds?.length) {
            yield* reconcileAffinityRules({
              scriptName: output.workerName,
              desired: undefined,
              previousZoneIds: output.affinityZoneIds,
            }).pipe(Effect.catch(() => Effect.void));
          }
          const redirects = stateWorkerDomain(output)?.redirects ?? [];
          if (redirects.length > 0) {
            yield* reconcileRedirectRules({
              scriptName: output.workerName,
              domain: undefined,
              zoneIdByHostname: new Map(
                liveDomains.flatMap((d) =>
                  d.hostname && d.zoneId
                    ? [[d.hostname, d.zoneId] as const]
                    : [],
                ),
              ),
              previousRedirects: redirects,
            }).pipe(Effect.catch(() => Effect.void));
          }
          if (liveDomains.length) {
            yield* Effect.all(
              liveDomains.flatMap((d) =>
                d.id
                  ? [
                      workers
                        .deleteDomain({
                          accountId: output.accountId,
                          domainId: d.id,
                        })
                        .pipe(
                          Effect.catchTag("DomainNotFound", () => Effect.void),
                        ),
                    ]
                  : [],
              ),
              { concurrency: "unbounded" },
            );
          }
          // Routes are zone-scoped; enumerating every zone live is
          // expensive, so trust the persisted route ids (refreshed by
          // `read`) and tolerate already-deleted routes.
          if (output.routes?.length) {
            yield* Effect.all(
              output.routes.map((route) =>
                workers
                  .deleteRoute({
                    zoneId: route.zoneId,
                    routeId: route.id,
                  })
                  .pipe(Effect.catchTag("RouteNotFound", () => Effect.void)),
              ),
              { concurrency: "unbounded" },
            );
          }
          yield* deleteWorkerScript(
            output.accountId,
            output.workerName,
            undefined,
          ).pipe(Effect.catchTag("WorkerNotFound", () => Effect.void));
        }),
        tail: ({ output }) =>
          telemetry.tailScript({
            accountId: output.accountId,
            scriptName: output.workerName,
          }),
        logs: ({ output, options }) =>
          telemetry.queryLogs({
            accountId: output.accountId,
            filters: [
              {
                key: "$workers.scriptName",
                operation: "eq",
                type: "string",
                value: output.workerName,
              },
            ],
            options,
          }),
      });
    }),
  );

const contentTypeForModule = (filePath: string) => {
  // Vendored Python packages upload as opaque data, mirroring Wrangler's
  // vendored-module rules — with one exception: the `workers-runtime-sdk`
  // JS shims under `python_modules/workers/` must be ES modules so the
  // runtime can resolve them via `import_from_javascript()`.
  if (filePath.startsWith("python_modules/")) {
    return filePath.startsWith("python_modules/workers/") &&
      /\.m?js$/.test(filePath)
      ? "application/javascript+module"
      : "application/octet-stream";
  }
  const dot = filePath.lastIndexOf(".");
  return contentTypeFromExtension(dot === -1 ? "" : filePath.slice(dot));
};

const contentTypeFromExtension = (extension: string) => {
  switch (extension) {
    case ".wasm":
      return "application/wasm";
    case ".txt":
    case ".html":
    case ".sql":
    case ".custom":
      return "text/plain";
    case ".bin":
      return "application/octet-stream";
    case ".mjs":
    case ".js":
      return "application/javascript+module";
    case ".cjs":
      return "application/javascript";
    case ".py":
      return "text/x-python";
    case ".map":
      return "application/source-map";
    default:
      return "application/octet-stream";
  }
};

/**
 * Observe every Durable Object namespace on the account as `(script, class)`
 * pairs. Namespace ownership is authoritative cloud state: after a
 * `transferred_classes` migration the namespace moves to the receiving
 * script, so this is how both sides of a transfer observe where a class
 * currently lives — the destination checks the source still hosts the class
 * before emitting the transfer, and the former host checks whether a class
 * it is about to delete has already been transferred away.
 */
const listDurableObjectNamespaces = (accountId: string) =>
  durableObjectsApi.listNamespaces.items({ accountId }).pipe(
    Stream.runCollect,
    Effect.map((namespaces) =>
      Array.from(namespaces).flatMap((ns) =>
        ns.script && ns.class ? [{ script: ns.script, class: ns.class }] : [],
      ),
    ),
  );

/**
 * Coerce a resolved `transferredFrom` declaration to its list form, dropping
 * self-references (a worker naming itself as its own former host is
 * meaningless — the class already lives there).
 */
const normalizeTransferSources = (
  value: string | readonly string[] | undefined,
  selfScriptName: string,
): string[] =>
  (value === undefined
    ? []
    : Array.isArray(value)
      ? value
      : [value as string]
  ).filter((source) => source !== selfScriptName);

function bumpMigrationTagVersion(
  oldTag: string | undefined,
): string | undefined {
  if (!oldTag) return undefined;
  const version = oldTag.match(/^(alchemy:)?v(\d+)$/)?.[2];
  if (!version) return "alchemy:v1";
  return `alchemy:v${parseInt(version, 10) + 1}`;
}

/**
 * Merges a worker's export-derived and binding-derived Durable Object class
 * lists for the precreate placeholder, deduping by class name. The
 * binding-derived entry wins on a collision so the `alchemy:dos:` tag keys off
 * the same logical id (the binding sid) that `reconcile` writes.
 */
function mergeDurableObjectClasses(
  exportDerived: ReadonlyArray<{
    logicalId: string;
    className: string;
    transferredFrom?: string | string[];
  }>,
  bindingDerived: ReadonlyArray<{
    logicalId: string;
    className: string;
    transferredFrom?: string | string[];
  }>,
) {
  return Array.from(
    new Map(
      [...exportDerived, ...bindingDerived].map(
        (binding) => [binding.className, binding] as const,
      ),
    ).values(),
  );
}

function getDurableObjectBindings(
  bindings: ReadonlyArray<ResourceBinding>,
  workerName: string,
) {
  // Resource authors (and the `make`/`yield* Tag`/plan-vs-apply machinery)
  // can register the same DO binding multiple times under the same logical
  // id — `binding()` is a plain `worker.bind` and intentionally has no
  // dedup. Collapse duplicates here so each `(logicalId, bindingName,
  // className)` tuple appears at most once. We also exclude cross-script
  // references: a `scriptName` pointing to *another* worker means this
  // worker just references a foreign class — ship the binding to
  // Cloudflare, but don't drive class migrations for it.
  const seen = new Set<string>();
  return bindings.flatMap((binding) =>
    (binding.data.bindings ?? []).flatMap((item: WorkerBinding) => {
      if (
        item.type !== "durable_object_namespace" ||
        !("className" in item) ||
        !item.className
      ) {
        return [];
      }
      if (item.scriptName !== undefined && item.scriptName !== workerName) {
        return [];
      }
      const dedupKey = `${binding.sid}::${item.name}::${item.className}`;
      if (seen.has(dedupKey)) return [];
      seen.add(dedupKey);
      return [
        {
          logicalId: binding.sid,
          bindingName: item.name,
          className: item.className,
          // Declared host history for a data-preserving
          // `transferred_classes` migration. Normalize an empty list to
          // "not declared"; self-references are dropped at resolution time.
          transferredFrom:
            Array.isArray(item.transferredFrom) &&
            item.transferredFrom.length === 0
              ? undefined
              : item.transferredFrom,
        },
      ];
    }),
  );
}

/**
 * Cloudflare Worker script-tag limits, verified empirically against the live
 * API (2026-07):
 *
 * - at most **10 tags** per Worker (the 11th is rejected with `Forbidden`)
 * - each tag is at most **1024 bytes** (`BadRequest: Tag is too large`)
 * - tags may not contain `,` or `&`; everything else (`:`, `;`, `=`, `/`,
 *   spaces, unicode) is accepted and round-trips intact
 *
 * Alchemy reserves 3 ownership tags (`alchemy:stack/stage/id`) and 1
 * migration tag, so the Durable Object logical-id→class mapping must not
 * spend one tag per DO (#811). Instead all mappings are packed into as few
 * `alchemy:dos:` tags as possible.
 */
const MAX_TAGS_PER_WORKER = 10;
const MAX_TAG_BYTES = 1024;
const LEGACY_DO_TAG_PREFIX = "alchemy:do:";
const PACKED_DO_TAG_PREFIX = "alchemy:dos:";

class InvalidWorkerTags extends Data.TaggedError("InvalidWorkerTags")<{
  scriptName: string;
  reason: string;
}> {}

/**
 * Pack Durable Object logical-id→class mappings into `alchemy:dos:` tags.
 *
 * Each mapping is encoded as `logicalId=className` — elided to just
 * `className` when the two are equal (the common case for export-derived
 * classes) — with both components `encodeURIComponent`-escaped so the `;`
 * pair separator, the `=` delimiter, and Cloudflare's forbidden tag
 * characters (`,`, `&`) can never collide with user identifiers. Pairs are
 * sorted for deterministic output and greedily packed so each tag stays
 * within Cloudflare's 1024-byte tag limit; workers with more DOs than fit in
 * one tag spill into additional `alchemy:dos:` tags.
 *
 * `encodeURIComponent` output is pure ASCII, so `String.length` equals the
 * tag's byte length.
 *
 * @internal exported for unit testing.
 */
export function encodeDurableObjectTags(
  durableObjects: ReadonlyArray<{ logicalId: string; className: string }>,
): string[] {
  const pairs = [...durableObjects]
    .sort((a, b) => a.logicalId.localeCompare(b.logicalId))
    .map(({ logicalId, className }) =>
      logicalId === className
        ? encodeURIComponent(className)
        : `${encodeURIComponent(logicalId)}=${encodeURIComponent(className)}`,
    );
  const tags: string[] = [];
  let payload = "";
  for (const pair of pairs) {
    const appended = payload === "" ? pair : `${payload};${pair}`;
    if (
      PACKED_DO_TAG_PREFIX.length + appended.length > MAX_TAG_BYTES &&
      payload !== ""
    ) {
      tags.push(`${PACKED_DO_TAG_PREFIX}${payload}`);
      payload = pair;
    } else {
      payload = appended;
    }
  }
  if (payload !== "") {
    tags.push(`${PACKED_DO_TAG_PREFIX}${payload}`);
  }
  return tags;
}

/**
 * Parse the Durable Object logical-id→class mapping from a worker's script
 * tags. Reads both formats so workers deployed before the packed format roll
 * forward transparently:
 *
 * - legacy: one `alchemy:do:{logicalId}:{className}` tag per DO
 * - packed: `alchemy:dos:{pair};{pair};…` (see {@link encodeDurableObjectTags})
 *
 * A packed entry wins over a legacy entry for the same logical id.
 *
 * @internal exported for unit testing.
 */
export function getDurableObjectTagMap(tags: ReadonlyArray<string>) {
  const map: Record<string, string> = {};
  for (const tag of tags) {
    if (tag.startsWith(LEGACY_DO_TAG_PREFIX)) {
      const parts = tag.split(":");
      const logicalId = parts[2];
      const className = parts.slice(3).join(":");
      if (logicalId && className && !(logicalId in map)) {
        map[logicalId] = className;
      }
    }
  }
  for (const tag of tags) {
    if (tag.startsWith(PACKED_DO_TAG_PREFIX)) {
      for (const pair of tag.slice(PACKED_DO_TAG_PREFIX.length).split(";")) {
        if (pair === "") continue;
        const eq = pair.indexOf("=");
        const logicalId = decodeURIComponent(
          eq === -1 ? pair : pair.slice(0, eq),
        );
        const className = decodeURIComponent(
          eq === -1 ? pair : pair.slice(eq + 1),
        );
        if (logicalId && className) {
          map[logicalId] = className;
        }
      }
    }
  }
  return map;
}

const isDurableObjectTag = (tag: string) =>
  tag.startsWith(LEGACY_DO_TAG_PREFIX) || tag.startsWith(PACKED_DO_TAG_PREFIX);

/**
 * Fail fast — before the script upload — when a worker's tag set violates
 * Cloudflare's limits, instead of surfacing the raw `Forbidden`/`BadRequest`
 * at PUT time (#811). `alchemyTagCount` is the number of tags alchemy itself
 * generated (ownership + migration + packed DO tags) so the message can tell
 * the user how much of the budget is theirs.
 */
const validateWorkerTags = (
  scriptName: string,
  tags: ReadonlyArray<string>,
  alchemyTagCount: number,
) =>
  Effect.gen(function* () {
    if (tags.length > MAX_TAGS_PER_WORKER) {
      return yield* Effect.fail(
        new InvalidWorkerTags({
          scriptName,
          reason:
            `worker "${scriptName}" needs ${tags.length} script tags but Cloudflare allows at most ${MAX_TAGS_PER_WORKER}. ` +
            `Alchemy reserves ${alchemyTagCount} (ownership, migration and durable-object metadata); ` +
            `${tags.length - alchemyTagCount} user tags were passed via \`tags\`. Remove ${tags.length - MAX_TAGS_PER_WORKER} tag(s).`,
        }),
      );
    }
    const encoder = new TextEncoder();
    for (const tag of tags) {
      if (tag.includes(",") || tag.includes("&")) {
        return yield* Effect.fail(
          new InvalidWorkerTags({
            scriptName,
            reason: `worker "${scriptName}" tag ${JSON.stringify(tag)} contains ',' or '&', which Cloudflare rejects.`,
          }),
        );
      }
      const bytes = yield* Effect.sync(() => encoder.encode(tag).length);
      if (bytes > MAX_TAG_BYTES) {
        return yield* Effect.fail(
          new InvalidWorkerTags({
            scriptName,
            reason: `worker "${scriptName}" tag ${JSON.stringify(tag.slice(0, 64))}… is ${bytes} bytes; Cloudflare allows at most ${MAX_TAG_BYTES}.`,
          }),
        );
      }
    }
  });
