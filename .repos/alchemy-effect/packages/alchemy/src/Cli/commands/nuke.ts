import * as Console from "effect/Console";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { Command, Flag } from "effect/unstable/cli";
import picomatch from "picomatch";

import type { ProviderService } from "../../Provider.ts";
import type { ProviderMode } from "../../ProviderMode.ts";
import * as Clank from "../../Util/Clank.ts";
import type { ScopedPlanStatusSession } from "../Cli.ts";
import { isNonInteractive } from "../selectCli.ts";
import * as NukeUI from "../tui/components/Nuke.tsx";

import {
  buildStackProviders,
  dryRun,
  envFile,
  instrumentCommand,
  profile,
  script,
  yes,
} from "./_shared.ts";

const includeFlag = Flag.string("include").pipe(
  Flag.withDescription(
    "Glob of provider IDs to include (e.g. 'Cloudflare.*' or 'Cloudflare.Worker'). " +
      "Repeatable; when omitted, every provider is included.",
  ),
  Flag.atLeast(0),
);

const excludeFlag = Flag.string("exclude").pipe(
  Flag.withDescription(
    "Glob of provider IDs to exclude (applied after --include). Repeatable.",
  ),
  Flag.atLeast(0),
);

const filterFlag = Flag.string("filter").pipe(
  Flag.withDescription(
    "JavaScript expression evaluated with `resource` in scope " +
      '(e.g. \'resource.Type === "Cloudflare.Worker" && ' +
      'resource.workerName.startsWith("alchemy-")\'). Any resource for which ' +
      "an expression is truthy is SPARED. Repeatable.",
  ),
  Flag.atLeast(0),
);

const verboseFlag = Flag.boolean("verbose").pipe(
  Flag.withAlias("v"),
  Flag.withDescription(
    "List every individual resource that will be deleted, not just per-provider counts.",
  ),
  Flag.withDefault(false),
);

const concurrencyFlag = Flag.integer("concurrency").pipe(
  Flag.withDescription(
    "Max number of providers scanned/deleted in parallel (resources within a " +
      "provider are always deleted concurrently). Use 0 for unbounded. " +
      "Default: 16 — unbounded tends to be slower because it triggers " +
      "provider-side rate limiting and retry backoff.",
  ),
  Flag.withDefault(16),
  Flag.map((n): number | "unbounded" => (n <= 0 ? "unbounded" : n)),
);

const timeoutFlag = Flag.integer("timeout").pipe(
  Flag.withDescription(
    "Per-provider timeout (seconds) for each list/delete call, so one slow or " +
      "hanging provider can't stall the whole run. Default: 120.",
  ),
  Flag.withDefault(120),
);

const independentFlag = Flag.boolean("independent").pipe(
  Flag.withDescription(
    "Delete every resource independently instead of in coordinated passes. " +
      "In pass mode a single slow or hanging delete delays the next pass for " +
      "everything; with --independent each resource retries its own delete " +
      "with backoff, in parallel, until it succeeds or --retries is " +
      "exhausted. Dependency violations resolve naturally as the blocking " +
      "resources are deleted concurrently.",
  ),
  Flag.withDefault(false),
);

const retriesFlag = Flag.integer("retries").pipe(
  Flag.withDescription(
    "With --independent: retries per resource after the initial delete " +
      "attempt (each attempt still bounded by --timeout). Default: 10.",
  ),
  Flag.withDefault(10),
);

const localFlag = Flag.boolean("local").pipe(
  Flag.withDescription(
    "Enumerate and delete LOCAL (emulated) resources instead of real cloud " +
      "ones — the floci-emulated AWS account and the Cloudflare local " +
      "runtime that `alchemy dev` provisions into. Only providers with a " +
      "local implementation participate, so nothing in the real cloud is " +
      "touched.",
  ),
  Flag.withDefault(false),
);

interface DiscoveredProvider {
  id: string;
  /**
   * Builds the provider service to enumerate/delete with. For the default
   * (live) mode this is the service already registered in context; with
   * `--local` it is the dual registration's lazily-built local variant, so
   * only the providers actually selected pay for constructing the local
   * runtime they emulate against (the floci container, workerd, ...).
   */
  resolve: Effect.Effect<ProviderService>;
}

const isProviderCollection = (
  value: unknown,
): value is { providers: Record<string, ProviderService | undefined> } =>
  typeof value === "object" &&
  value !== null &&
  (value as { kind?: unknown }).kind === "ProviderCollection";

const hasListAndDelete = (value: unknown): value is ProviderService =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ProviderService).list === "function" &&
  typeof (value as ProviderService).delete === "function";

/**
 * Walk the built provider context and extract every resource provider keyed
 * by its provider ID (e.g. `"Cloudflare.Worker"`). Providers live inside a
 * {@link ProviderCollectionService}; we also pick up any directly-registered
 * provider whose key looks like a resource type. Only providers exposing a
 * `list` method are returned — policies and bindings are skipped.
 *
 * With `mode: "local"` only providers registered via `ProviderLayer.dual`
 * (the ones carrying {@link ProviderService.modes}) are returned, resolving
 * to their local variant — an AWS resource emulated by floci, a Cloudflare
 * resource emulated by the local runtime. Mode-agnostic providers are
 * deliberately dropped: they have a single implementation that talks to the
 * real cloud, so including them would make `--local` delete live
 * infrastructure.
 */
const discoverProviders = (
  context: Context.Context<never>,
  mode: ProviderMode,
): DiscoveredProvider[] => {
  // Resources opted out of teardown (`nuke.singleton` settings whose delete
  // only resets, or `nuke.skip` resources that can never be deleted) would be
  // re-enumerated and "re-deleted" every run — skip them.
  const isNukeable = (p: ProviderService) =>
    !p.nuke?.singleton && !p.nuke?.skip;
  const out = new Map<string, ProviderService>();
  for (const [key, value] of context.mapUnsafe.entries()) {
    if (isProviderCollection(value)) {
      for (const [id, provider] of Object.entries(value.providers)) {
        if (
          provider &&
          typeof provider.list === "function" &&
          isNukeable(provider)
        ) {
          out.set(id, provider);
        }
      }
    } else if (
      typeof key === "string" &&
      key.includes(".") &&
      hasListAndDelete(value) &&
      isNukeable(value)
    ) {
      out.set(key, value);
    }
  }
  return [...out.entries()]
    .flatMap(([id, provider]): DiscoveredProvider[] => {
      if (mode === "live") return [{ id, resolve: Effect.succeed(provider) }];
      // No `modes` => mode-agnostic (single, live implementation).
      const local = provider.modes?.local;
      return local ? [{ id, resolve: local }] : [];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
};

/**
 * Compile a `--filter` expression into a predicate. The expression is
 * evaluated with `{ resource }` placed on the scope chain via `with`, so it
 * can reference `resource.Type`, `resource.LogicalId`, and any attribute
 * directly. A throwing or non-boolean expression is treated as `false`.
 */
const compileFilter = (
  expr: string,
): ((resource: Record<string, unknown>) => boolean) => {
  // `new Function` bodies are sloppy-mode, so `with` is permitted here even
  // though this module is ESM/strict.
  const fn = new Function(
    "scope",
    `with (scope) { return (${expr}); }`,
  ) as (scope: { resource: Record<string, unknown> }) => unknown;
  return (resource) => {
    try {
      return Boolean(fn({ resource }));
    } catch {
      return false;
    }
  };
};

/**
 * High-signal identifier attributes, most human-friendly first. These are the
 * explicit per-resource identifier keys observed across the AWS / Cloudflare /
 * Planetscale / Neon / GitHub providers (e.g. `Worker.workerName`,
 * `Function.functionName`, `Table.tableName`, `Zone.name`, `Route.pattern`).
 * The generic suffix passes in {@link displayName} cover everything else.
 */
const PRIMARY_NAME_KEYS = [
  "workerName",
  "functionName",
  "bucketName",
  "tableName",
  "queueName",
  "streamName",
  "topicName",
  "roleName",
  "userName",
  "groupName",
  "clusterName",
  "serviceName",
  "repositoryName",
  "databaseName",
  "branchName",
  "projectName",
  "tunnelName",
  "secretName",
  "storeName",
  "scriptName",
  "workflowName",
  "loadBalancerName",
  "indexName",
  "applicationName",
  "fullName",
  "domainName",
  "hostname",
  "dnsName",
  "pattern",
  "displayName",
  "friendlyName",
  "commonName",
  "slug",
  "name",
];

/**
 * Generic identifiers shared by many resources that make poor display labels.
 * Only used as a last resort, after suffix-based matching.
 */
const WEAK_KEYS = ["accountId", "zoneId"];

const stringAttr = (
  attr: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = attr[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/** First non-weak string attribute whose key ends with one of `suffixes`. */
const findBySuffix = (
  attr: Record<string, unknown>,
  suffixes: string[],
): string | undefined => {
  for (const key of Object.keys(attr)) {
    if (WEAK_KEYS.includes(key)) continue;
    if (suffixes.some((s) => key.endsWith(s))) {
      const value = stringAttr(attr, key);
      if (value) return value;
    }
  }
  return undefined;
};

/**
 * Best-effort human-readable identifier for a discovered resource. Tries, in
 * order: an explicit high-signal key ({@link PRIMARY_NAME_KEYS}), then any
 * `*Name`, `*Arn`, `*Url`/endpoint/host, or `*Id` attribute, then a weak
 * generic id, then any string value.
 */
const displayName = (attr: Record<string, unknown>): string =>
  PRIMARY_NAME_KEYS.map((key) => stringAttr(attr, key)).find(Boolean) ??
  findBySuffix(attr, ["Name", "name"]) ??
  findBySuffix(attr, ["Arn", "arn"]) ??
  findBySuffix(attr, ["Url", "url"]) ??
  stringAttr(attr, "endpoint") ??
  stringAttr(attr, "host") ??
  findBySuffix(attr, ["Id", "id"]) ??
  WEAK_KEYS.map((key) => stringAttr(attr, key)).find(Boolean) ??
  Object.values(attr).find(
    (value): value is string => typeof value === "string" && value.length > 0,
  ) ??
  "";

const groupBy = <T>(items: T[], key: (item: T) => string): Map<string, T[]> => {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
};

const addEdge = (map: Map<string, Set<string>>, from: string, to: string) => {
  const set = map.get(from) ?? new Set<string>();
  set.add(to);
  map.set(from, set);
};

/**
 * Strongly-connected components of the type-level teardown-dependency graph
 * (Tarjan). Components are emitted in reverse topological order of the
 * condensation — every component's successors are emitted before it — so
 * callers can compute layers by iterating the result backwards.
 */
const stronglyConnectedComponents = (
  nodes: readonly string[],
  successors: Map<string, Set<string>>,
): string[][] => {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;
  const strongConnect = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of successors.get(v) ?? []) {
      if (!index.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      components.push(component);
    }
  };
  for (const v of nodes) {
    if (!index.has(v)) strongConnect(v);
  }
  return components;
};

const nukeSession: ScopedPlanStatusSession = {
  emit: () => Effect.void,
  done: () => Effect.void,
  note: () => Effect.void,
};
const nukeCommand = Command.make(
  "nuke",
  {
    main: script,
    envFile,
    profile,
    yes,
    dryRun,
    verbose: verboseFlag,
    concurrency: concurrencyFlag,
    timeout: timeoutFlag,
    independent: independentFlag,
    retries: retriesFlag,
    include: includeFlag,
    exclude: excludeFlag,
    filter: filterFlag,
    local: localFlag,
  },
  instrumentCommand("unsafe.nuke", (a: { profile: string; main: string }) => ({
    "alchemy.profile": a.profile,
    "alchemy.main": a.main,
  }))(
    Effect.fn(function* ({
      main,
      envFile,
      profile,
      yes,
      dryRun,
      verbose,
      concurrency,
      timeout,
      independent,
      retries,
      include,
      exclude,
      filter,
      local,
    }) {
      // DEBUG=1 routes provider logs to the console (instead of the
      // .alchemy/log/out file) at Debug level and disables the TUI so the
      // log stream isn't clobbered by the progress renderer.
      const debug = !!process.env.DEBUG;
      const interactive = !isNonInteractive() && !debug;

      // Build the user's providers() (+ state) layer so the resulting context
      // holds every resource provider plus the cloud-environment services
      // their `list`/`delete` need at call time. DEBUG=1 routes provider logs
      // to the console at Debug level instead of the .alchemy/log/out file.
      const { context } = yield* buildStackProviders({
        main,
        envFile,
        profile,
        logger: debug ? Logger.layer([Logger.defaultLogger]) : undefined,
        extra: Layer.succeed(MinimumLogLevel, debug ? "Debug" : "Info"),
      });

      const mode: ProviderMode = local ? "local" : "live";
      const discovered = discoverProviders(
        context as Context.Context<never>,
        mode,
      );

      const matchInclude =
        include.length > 0 ? picomatch([...include]) : () => true;
      const matchExclude =
        exclude.length > 0 ? picomatch([...exclude]) : () => false;
      const selected = discovered.filter(
        (p) => matchInclude(p.id) && !matchExclude(p.id),
      );

      if (local) {
        yield* Console.log(
          `Local mode: ${selected.length} emulated provider(s). ` +
            "Real cloud resources are never touched.",
        );
      }

      if (selected.length === 0) {
        yield* Console.log(
          local
            ? "No local providers match the given --include/--exclude."
            : "No providers match the given --include/--exclude.",
        );
        return;
      }

      // Predicates that SPARE a matching resource from deletion. Applied
      // during the scan so the live counts reflect the filter rather than
      // the raw discovered total.
      const predicates = filter.map(compileFilter);
      const isSpared = (attr: Record<string, unknown>, id: string) =>
        predicates.some((p) =>
          p({ ...attr, Type: id, LogicalId: displayName(attr) }),
        );

      // ---- Scan phase --------------------------------------------------
      const scanUI = interactive
        ? yield* Effect.sync(() => NukeUI.renderScan(selected.length))
        : undefined;
      const emitScan = (event: NukeUI.ScanEvent) =>
        scanUI ? Effect.sync(() => scanUI.emit(event)) : Effect.void;

      const listed = yield* Effect.all(
        selected.map(({ id, resolve }) =>
          Effect.gen(function* () {
            yield* emitScan({ kind: "start", id });
            // Resolving is a no-op in live mode; in local mode it builds the
            // provider's local variant (and, on first use, whatever runtime
            // it emulates against). Both it and the listing are guarded, so
            // a provider whose local runtime can't start is skipped with a
            // logged warning instead of aborting the whole run.
            const scanned = yield* Effect.gen(function* () {
              const provider = yield* resolve;
              const attrs = yield* provider
                .list()
                .pipe(Effect.timeout(`${timeout} seconds`));
              return { provider, attrs };
            }).pipe(
              // Log inside the provided scope so the failure lands in the
              // stack's file logger (.alchemy/log/out), then swallow it so a
              // single broken/slow provider doesn't abort the whole scan.
              Effect.tapCause((cause) =>
                Effect.logWarning(`nuke: scan failed for ${id}`, cause),
              ),
              Effect.provide(context),
              Effect.matchCause({
                onSuccess: (scanned) => scanned,
                onFailure: () => undefined,
              }),
            );
            const items = (scanned?.attrs ?? []).map((raw) => {
              const attr = (raw ?? {}) as Record<string, unknown>;
              return {
                attr,
                name: displayName(attr),
                spared: isSpared(attr, id),
              };
            });
            yield* emitScan({
              kind: "done",
              id,
              count: items.filter((i) => !i.spared).length,
            });
            return { id, provider: scanned?.provider, items };
          }),
        ),
        { concurrency },
      );

      if (scanUI) {
        yield* Effect.sleep(10);
        yield* Effect.sync(() => scanUI.unmount());
      }

      // ---- Filter phase ------------------------------------------------
      const candidates = listed.flatMap(({ id, provider, items }) =>
        // `provider` is only undefined when the scan failed, in which case
        // `items` is empty and nothing is emitted.
        provider === undefined
          ? []
          : items.map(({ attr, name, spared }) => ({
              id,
              provider,
              attr,
              name,
              spared,
            })),
      );

      const targets = candidates.filter((c) => !c.spared);
      const filteredTotal = candidates.length - targets.length;

      // ---- Report ------------------------------------------------------
      // One line per provider type with its to-delete count and how many were
      // filtered out by --filter. With --verbose, also enumerate each
      // individual resource that will be deleted.
      const byType = [...groupBy(candidates, (c) => c.id).entries()].sort(
        (a, b) => a[0].localeCompare(b[0]),
      );
      yield* Console.log("");
      yield* Effect.forEach(
        byType,
        ([id, items]) =>
          Effect.gen(function* () {
            const toDelete = items.filter((c) => !c.spared);
            const filtered = items.length - toDelete.length;
            yield* Console.log(
              `${id}  ${toDelete.length} to delete` +
                (filtered > 0 ? ` (${filtered} filtered out)` : ""),
            );
            if (verbose) {
              yield* Effect.forEach(
                toDelete,
                (c) => Console.log(`  - ${c.name}`),
                { discard: true },
              );
            }
          }),
        { discard: true },
      );

      yield* Console.log("");
      yield* Console.log(
        filteredTotal > 0
          ? `${targets.length} resource(s) to delete (${filteredTotal} filtered out).`
          : `${targets.length} resource(s) to delete.`,
      );

      if (targets.length === 0) {
        yield* Console.log("Nothing to delete.");
        return;
      }

      if (dryRun) {
        yield* Console.log(
          "Dry run: nothing was deleted. Re-run without --dry-run to delete.",
        );
        return;
      }

      // ---- Confirm -----------------------------------------------------
      const approved = yes
        ? true
        : yield* Clank.confirm({
            message:
              `Permanently DELETE ${targets.length} ` +
              `${local ? "locally emulated " : ""}resource(s)? ` +
              `This cannot be undone.`,
            initialValue: false,
          });
      if (!approved) {
        yield* Console.log("Aborted.");
        return;
      }

      // ---- Delete phase ------------------------------------------------
      const totals = [...groupBy(targets, (t) => t.id).entries()].map(
        ([id, items]) => ({ id, total: items.length }),
      );
      const deleteUI = interactive
        ? yield* Effect.sync(() => NukeUI.renderDelete(totals))
        : undefined;
      const emitDelete = (event: NukeUI.DeleteEvent) =>
        deleteUI ? Effect.sync(() => deleteUI.emit(event)) : Effect.void;

      // One delete attempt for a single resource, bounded by --timeout, with
      // the failure cause logged to the stack's file logger. Failure stays on
      // the error channel so callers can retry or fold it as they see fit.
      const attemptDelete = (item: (typeof targets)[number]) =>
        item.provider
          .delete({
            id: displayName(item.attr),
            // Enumerated straight from the cloud, so there is no
            // Alchemy namespace — an un-namespaced fqn is just the id.
            fqn: displayName(item.attr),
            instanceId: "",
            olds: item.attr as never,
            output: item.attr as never,
            session: nukeSession,
            bindings: [],
            // Nuke is an explicit, operator-confirmed account
            // teardown: allow destructive prerequisites (e.g.
            // emptying a bucket) that normal destroys gate behind
            // props such as `forceDestroy` — `olds` here is cloud
            // Attributes, not the originally-deployed Props.
            force: true,
          })
          .pipe(
            Effect.timeout(`${timeout} seconds`),
            Effect.tapCause((cause) =>
              Effect.logWarning(
                `nuke: delete failed for ${item.id} ${displayName(item.attr)}`,
                cause,
              ),
            ),
            Effect.provide(context),
          );

      const retrySchedule = Schedule.min([
        Schedule.exponential("1 second"),
        Schedule.spaced("15 seconds"),
      ]);

      let pass = 0;

      // Delete one tier of resources to completion, returning the items
      // that could not be deleted.
      const runTier = (tier: typeof targets) =>
        Effect.gen(function* () {
          if (tier.length === 0) return [] as typeof targets;
          if (independent) {
            // Independent mode: no pass barrier. Every resource retries its
            // own delete with capped exponential backoff, all in parallel
            // (provider groups bounded by --concurrency, resources within a
            // provider unbounded, matching pass mode). A dependency
            // violation resolves on a later attempt once the blocking
            // resource's concurrent delete lands — a hanging delete only
            // ever stalls itself.
            pass += 1;
            yield* emitDelete({ kind: "pass", pass });
            const results = yield* Effect.all(
              [...groupBy(tier, (t) => t.id).values()].map((items) =>
                Effect.all(
                  items.map((item) =>
                    attemptDelete(item).pipe(
                      Effect.retry({ schedule: retrySchedule, times: retries }),
                      Effect.matchCause({
                        onSuccess: () => ({ item, ok: true as const }),
                        onFailure: () => ({ item, ok: false as const }),
                      }),
                      // Only the final outcome is emitted, so the UI's
                      // failure count reflects exhausted resources, not
                      // transient attempts.
                      Effect.tap((r) =>
                        r.ok
                          ? emitDelete({ kind: "deleted", id: item.id })
                          : emitDelete({ kind: "failed", id: item.id }),
                      ),
                    ),
                  ),
                  { concurrency: "unbounded" },
                ),
              ),
              { concurrency },
            );
            return results.flat().flatMap((r) => (r.ok ? [] : [r.item]));
          }
          let remaining = tier;
          while (remaining.length > 0) {
            pass += 1;
            yield* emitDelete({ kind: "pass", pass });

            const byType = groupBy(remaining, (t) => t.id);
            const results = yield* Effect.all(
              [...byType.values()].map((items) =>
                Effect.all(
                  items.map((item) =>
                    attemptDelete(item).pipe(
                      Effect.matchCause({
                        onSuccess: () => ({ item, ok: true as const }),
                        onFailure: () => ({ item, ok: false as const }),
                      }),
                      Effect.tap((r) =>
                        r.ok
                          ? emitDelete({ kind: "deleted", id: item.id })
                          : emitDelete({ kind: "failed", id: item.id }),
                      ),
                    ),
                  ),
                  { concurrency: "unbounded" },
                ),
              ),
              { concurrency },
            );

            const failed = results
              .flat()
              .flatMap((r) => (r.ok ? [] : [r.item]));
            // No resource deleted this pass: dependencies can't resolve
            // further, so stop instead of looping forever.
            if (failed.length === remaining.length) {
              return failed;
            }
            remaining = failed;
          }
          return remaining;
        });

      // ---- Teardown-dependency ordering ---------------------------------
      // Providers declare `nuke.dependsOn: [globs]` when their cloud-side
      // teardown CONSUMES another type (e.g. SageMaker HyperPod deletes
      // node ENIs by assuming the instance group's execution role inside
      // the cluster's VPC — deleting the role or network mid-teardown
      // wedges the cluster in `Deleting` forever). Edge A→B means every A
      // must be fully GONE before any B is deleted. Only types present in
      // the target set participate, so the constraint costs nothing when no
      // dependent resources exist; declaration cycles collapse into one
      // concurrent wave (handled by the intra-wave retry machinery) with a
      // logged warning instead of failing.
      const typeIds = [...new Set(targets.map((t) => t.id))];
      const providerOfType = new Map(targets.map((t) => [t.id, t.provider]));
      const successors = new Map<string, Set<string>>();
      const predecessors = new Map<string, Set<string>>();
      for (const id of typeIds) {
        const globs = providerOfType.get(id)?.nuke?.dependsOn;
        if (!globs || globs.length === 0) continue;
        const matches = picomatch([...globs]);
        for (const other of typeIds) {
          if (other === id || !matches(other)) continue;
          addEdge(successors, id, other);
          addEdge(predecessors, other, id);
        }
      }

      const components = stronglyConnectedComponents(typeIds, successors);
      for (const component of components) {
        if (component.length > 1) {
          yield* Effect.logWarning(
            `nuke: teardown-dependency cycle between ${component.join(", ")} — deleting them concurrently`,
          ).pipe(Effect.provide(context));
        }
      }
      const compOf = new Map<string, number>();
      components.forEach((component, i) => {
        for (const node of component) compOf.set(node, i);
      });
      // Layer each component: 0 for sources, else 1 + max predecessor
      // layer. Tarjan emits components in reverse topological order, so
      // iterating backwards visits predecessors before dependents.
      const layerOfComp: number[] = new Array(components.length).fill(0);
      for (let i = components.length - 1; i >= 0; i--) {
        let layer = 0;
        for (const node of components[i]!) {
          for (const pred of predecessors.get(node) ?? []) {
            const predComp = compOf.get(pred)!;
            if (predComp !== i) {
              layer = Math.max(layer, layerOfComp[predComp]! + 1);
            }
          }
        }
        layerOfComp[i] = layer;
      }
      const waves: string[][] = [];
      components.forEach((component, i) => {
        (waves[layerOfComp[i]!] ??= []).push(...component);
      });

      // ---- Execute waves -------------------------------------------------
      const targetsOfType = groupBy(targets, (t) => t.id);
      const remainingCount = new Map(
        [...targetsOfType.entries()].map(([id, items]) => [id, items.length]),
      );
      const remaining: typeof targets = [];
      const held: string[] = [];
      for (const wave of waves) {
        const runnable: typeof targets = [];
        for (const typeId of wave) {
          const items = targetsOfType.get(typeId) ?? [];
          // A dependent type still has undeleted resources — deleting this
          // type now could wedge their in-flight teardown, which is exactly
          // what the ordering exists to prevent. Hold it back and report.
          const blockers = [...(predecessors.get(typeId) ?? [])].filter(
            (pred) =>
              compOf.get(pred) !== compOf.get(typeId) &&
              (remainingCount.get(pred) ?? 0) > 0,
          );
          if (blockers.length > 0) {
            held.push(`${typeId} (blocked by ${blockers.join(", ")})`);
            remaining.push(...items);
            for (const item of items) {
              yield* emitDelete({ kind: "failed", id: item.id });
            }
            continue;
          }
          runnable.push(...items);
        }
        const failed = yield* runTier(runnable);
        remaining.push(...failed);
        const failedOfType = groupBy(failed, (t) => t.id);
        for (const typeId of new Set(runnable.map((t) => t.id))) {
          remainingCount.set(typeId, failedOfType.get(typeId)?.length ?? 0);
        }
      }

      if (deleteUI) {
        yield* Effect.sleep(10);
        yield* Effect.sync(() => deleteUI.unmount());
      }

      const deleted = targets.length - remaining.length;
      yield* Console.log("");
      yield* Console.log(
        independent
          ? `Deleted ${deleted} resource(s).`
          : `Deleted ${deleted} resource(s) over ${pass} pass(es).`,
      );
      if (held.length > 0) {
        yield* Console.log(
          `Held back (their dependent types could not be fully deleted): ${held.join("; ")}`,
        );
      }
      if (remaining.length > 0) {
        yield* Console.log(
          `${remaining.length} resource(s) could not be deleted.`,
        );
      }
    }),
  ),
).pipe(
  // hide the command because it's dangerous and we don't want agents to discover and use it
  Command.unlisted,
  Command.withDescription(
    "Enumerate every live resource across the stack's providers and delete " +
      "them. DESTRUCTIVE — use --include/--exclude/--filter to scope it. " +
      "Pass --local to target locally emulated resources (floci, the " +
      "Cloudflare local runtime) instead of the real cloud.",
  ),
);

export const unsafeCommand = Command.make("unsafe", {}).pipe(
  Command.withDescription("Dangerous, irreversible operations."),
  Command.withSubcommands([nukeCommand]),
);
