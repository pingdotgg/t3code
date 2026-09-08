import { Services } from "@distilled.cloud/hetzner";
import type {
  CreateFirewallRequestApplyToItem,
  CreateFirewallRequestRulesItem,
  GetFirewallResponseFirewall,
  GetFirewallResponseFirewallAppliedToItem,
  GetFirewallResponseFirewallRulesItem,
  ListFirewallsResponseFirewallsItem,
} from "@distilled.cloud/hetzner/firewalls";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { recordsEqual } from "../Util/equal.ts";
import { waitForActions } from "./actions.ts";
import {
  alchemyStackSelector,
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  labelSelector,
  stripInternalLabels,
  toLabels,
} from "./Labels.ts";
import type { Providers } from "./Providers.ts";

/**
 * Resource-valued prop. The engine resolves `Effect`s (including other
 * Resources) before lifecycle operations see the value.
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Server identity used by `applyTo`. A `Hetzner.Server` resource
 * satisfies this via `serverId`.
 */
type Server = {
  readonly serverId: number;
};

export type FirewallDirection = "in" | "out";
export type FirewallProtocol = "tcp" | "udp" | "icmp" | "esp" | "gre";

export interface FirewallRule {
  /**
   * Description of the rule.
   */
  description?: string;
  /**
   * Traffic direction. Incoming rules use `sourceIps`; outgoing rules
   * use `destinationIps`.
   */
  direction: FirewallDirection;
  /**
   * Network protocol this rule applies to.
   */
  protocol: FirewallProtocol;
  /**
   * Port or port range (`22` or `1024-5000`). Only valid for `tcp` and
   * `udp`.
   */
  port?: string;
  /**
   * Permitted source CIDRs for incoming traffic. Use `0.0.0.0/0` and
   * `::/0` to allow any address.
   */
  sourceIps?: string[];
  /**
   * Permitted destination CIDRs for outgoing traffic. Use `0.0.0.0/0`
   * and `::/0` to allow any address.
   */
  destinationIps?: string[];
}

export interface FirewallProps {
  /**
   * Name of the firewall. Must be unique per Hetzner project. If
   * omitted, a unique name is generated from `${stack}-${id}-${stage}`.
   */
  name?: string;
  /**
   * Firewall rules. Limited to 50 entries per firewall. An empty list
   * (the default) drops all inbound traffic and accepts all outbound
   * traffic.
   */
  rules?: FirewallRule[];
  /**
   * Servers this firewall is applied to. This wave's tests leave
   * `applyTo` empty; the type still accepts `Server` resources.
   */
  applyTo?: Array<Ref<Server>>;
  /**
   * User-defined labels. Alchemy ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`) are always merged in.
   */
  labels?: Record<string, string>;
}

export type FirewallAppliedTo = {
  type: "server";
  serverId: number;
};

export interface Firewall extends Resource<
  "Hetzner.Firewall",
  FirewallProps,
  {
    /**
     * Numeric Hetzner firewall id.
     */
    id: number;
    /**
     * Name of the firewall.
     */
    name: string;
    /**
     * RFC3339 timestamp when the firewall was created.
     */
    created: string;
    /**
     * Current rules, in the same camelCase shape as {@link FirewallRule}.
     */
    rules: FirewallRule[];
    /**
     * Server ids the firewall is currently applied to (direct
     * `type=server` attachments only).
     */
    appliedTo: FirewallAppliedTo[];
    /**
     * User-facing labels (Alchemy ownership labels stripped).
     */
    labels: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Hetzner Cloud firewall — a named set of inbound/outbound rules that
 * can be applied to one or more Servers.
 *
 * Name, rules, labels, and `applyTo` are all mutable. Changing the name
 * updates the existing firewall in place (it is unique per project).
 * @see https://docs.hetzner.cloud/reference/cloud#firewalls
 *
 * ### Creating a Firewall
 * **Example:** Basic firewall
 * ```typescript
 * const web = yield* Hetzner.Firewall("web", {
 *   rules: [
 *     {
 *       direction: "in",
 *       protocol: "tcp",
 *       port: "22",
 *       sourceIps: ["0.0.0.0/0", "::/0"],
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Firewall applied to a Server
 * ```typescript
 * const server = yield* Hetzner.Server("app", {
 *   image: "ubuntu-24.04",
 *   serverType: "cx22",
 *   location: "nbg1",
 * });
 * const web = yield* Hetzner.Firewall("web", {
 *   applyTo: [server],
 *   rules: [
 *     {
 *       direction: "in",
 *       protocol: "tcp",
 *       port: "443",
 *       sourceIps: ["0.0.0.0/0", "::/0"],
 *     },
 *   ],
 * });
 * ```
 *
 * ### Updating rules
 * **Example:** Replace the rule set
 * ```typescript
 * const web = yield* Hetzner.Firewall("web", {
 *   rules: [
 *     {
 *       direction: "in",
 *       protocol: "tcp",
 *       port: "80",
 *       sourceIps: ["0.0.0.0/0", "::/0"],
 *     },
 *     {
 *       direction: "in",
 *       protocol: "tcp",
 *       port: "443",
 *       sourceIps: ["0.0.0.0/0", "::/0"],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const Firewall = Resource<Firewall>("Hetzner.Firewall");

export class FirewallNotCreated extends Data.TaggedError(
  "Hetzner.FirewallNotCreated",
)<{
  name: string;
}> {}

type FirewallAttributes = Firewall["Attributes"];
type ObservedFirewall =
  | GetFirewallResponseFirewall
  | ListFirewallsResponseFirewallsItem;

const NAME_MAX_LENGTH = 128;

const createFirewallName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    return yield* createPhysicalName({ id, maxLength: NAME_MAX_LENGTH });
  });

const compactLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(labels ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const desiredLabels = Effect.fn(function* (
  id: string,
  user: Record<string, string> | undefined,
) {
  const internal = yield* createInternalLabels(id);
  return { ...toLabels(user), ...internal };
});

const sortIps = (ips: ReadonlyArray<string> | undefined): string[] =>
  [...(ips ?? [])].map((ip) => ip.toLowerCase()).sort();

const normalizeRule = (rule: {
  description?: string | null;
  direction: string;
  protocol: string;
  port?: string | null;
  sourceIps?: ReadonlyArray<string>;
  destinationIps?: ReadonlyArray<string>;
}): FirewallRule => {
  const description = rule.description ?? undefined;
  const port = rule.port ?? undefined;
  return {
    direction: rule.direction as FirewallDirection,
    protocol: rule.protocol as FirewallProtocol,
    ...(description !== undefined ? { description } : {}),
    ...(port !== undefined && port.length > 0 ? { port } : {}),
    sourceIps: sortIps(rule.sourceIps),
    destinationIps: sortIps(rule.destinationIps),
  };
};

const fromObservedRule = (
  rule: GetFirewallResponseFirewallRulesItem,
): FirewallRule =>
  normalizeRule({
    description: rule.description,
    direction: rule.direction,
    protocol: rule.protocol,
    port: rule.port,
    sourceIps: rule.source_ips,
    destinationIps: rule.destination_ips,
  });

const toWireRule = (rule: FirewallRule): CreateFirewallRequestRulesItem => {
  const description = rule.description;
  const port =
    (rule.protocol === "tcp" || rule.protocol === "udp") && rule.port
      ? rule.port
      : undefined;
  return {
    direction: rule.direction,
    protocol: rule.protocol,
    ...(description !== undefined ? { description } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(rule.sourceIps !== undefined
      ? { source_ips: [...rule.sourceIps] }
      : {}),
    ...(rule.destinationIps !== undefined
      ? { destination_ips: [...rule.destinationIps] }
      : {}),
  };
};

const desiredRules = (rules: FirewallRule[] | undefined): FirewallRule[] =>
  (rules ?? []).map((rule) =>
    normalizeRule({
      description: rule.description,
      direction: rule.direction,
      protocol: rule.protocol,
      port: rule.port,
      sourceIps: rule.sourceIps,
      destinationIps: rule.destinationIps,
    }),
  );

const rulesEqual = (a: FirewallRule[], b: FirewallRule[]): boolean =>
  deepEqual(a, b, { stripNullish: true });

const serverIdOf = (value: unknown): number | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { serverId?: unknown; id?: unknown };
  if (typeof rec.serverId === "number") return rec.serverId;
  if (typeof rec.id === "number") return rec.id;
  return undefined;
};

const desiredServerIds = (
  applyTo: FirewallProps["applyTo"] | undefined,
): number[] => {
  const ids = new Set<number>();
  for (const item of applyTo ?? []) {
    const id = serverIdOf(item);
    if (id !== undefined) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
};

const observedServerIds = (
  appliedTo: ReadonlyArray<GetFirewallResponseFirewallAppliedToItem>,
): number[] => {
  const ids = new Set<number>();
  for (const item of appliedTo) {
    if (item.type === "server" && item.server?.id !== undefined) {
      ids.add(item.server.id);
    }
  }
  return [...ids].sort((a, b) => a - b);
};

const toAppliedTo = (
  appliedTo: ReadonlyArray<GetFirewallResponseFirewallAppliedToItem>,
): FirewallAppliedTo[] =>
  observedServerIds(appliedTo).map((serverId) => ({
    type: "server" as const,
    serverId,
  }));

const toServerApplyItems = (
  ids: ReadonlyArray<number>,
): CreateFirewallRequestApplyToItem[] =>
  ids.map((id) => ({ type: "server" as const, server: { id } }));

const detachItems = (
  appliedTo: ReadonlyArray<GetFirewallResponseFirewallAppliedToItem>,
): CreateFirewallRequestApplyToItem[] => {
  const items: CreateFirewallRequestApplyToItem[] = [];
  for (const item of appliedTo) {
    if (item.type === "server" && item.server?.id !== undefined) {
      items.push({ type: "server", server: { id: item.server.id } });
    } else if (
      item.type === "label_selector" &&
      item.label_selector?.selector !== undefined
    ) {
      items.push({
        type: "label_selector",
        label_selector: { selector: item.label_selector.selector },
      });
    }
  }
  return items;
};

const toAttrs = (firewall: ObservedFirewall): FirewallAttributes => ({
  id: firewall.id,
  name: firewall.name,
  created: firewall.created,
  rules: firewall.rules.map(fromObservedRule),
  appliedTo: toAppliedTo(firewall.applied_to),
  labels: stripInternalLabels(compactLabels(firewall.labels)),
});

const getById = (id: number) =>
  Services.firewalls.getFirewall({ id }).pipe(
    Effect.map(({ firewall }) => firewall),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const findByName = (name: string) =>
  Effect.gen(function* () {
    const { firewalls } = yield* Services.firewalls.listFirewalls({
      name,
      per_page: 50,
    });
    return firewalls.find((item) => item.name === name);
  });

const findByLabels = (id: string) =>
  Effect.gen(function* () {
    const selector = labelSelector(yield* createInternalLabels(id));
    const { firewalls } = yield* Services.firewalls.listFirewalls({
      label_selector: selector,
      per_page: 50,
    });
    return firewalls[0];
  });

const observe = (input: {
  id: string;
  name: string;
  output: FirewallAttributes | undefined;
}) =>
  Effect.gen(function* () {
    if (input.output?.id !== undefined) {
      const byId = yield* getById(input.output.id);
      if (byId !== undefined) return byId;
    }
    const byName = yield* findByName(input.name);
    if (byName !== undefined) return byName;
    return yield* findByLabels(input.id);
  });

const waitActions = (actions: ReadonlyArray<{ readonly id: number }>) =>
  waitForActions(actions.map((action) => action.id));

const ensureFirewall = Effect.fn(function* (input: {
  name: string;
  labels: Record<string, string>;
  rules: FirewallRule[];
  serverIds: number[];
}) {
  const created = yield* Services.firewalls
    .createFirewall({
      name: input.name,
      labels: input.labels,
      ...(input.rules.length > 0 ? { rules: input.rules.map(toWireRule) } : {}),
      ...(input.serverIds.length > 0
        ? { apply_to: toServerApplyItems(input.serverIds) }
        : {}),
    })
    .pipe(
      Effect.catchTag("Conflict", () =>
        findByName(input.name).pipe(
          Effect.flatMap((existing) =>
            existing !== undefined
              ? Effect.succeed({ firewall: existing, actions: [] })
              : Services.firewalls
                  .listFirewalls({
                    name: input.name,
                    per_page: 1,
                  })
                  .pipe(
                    Effect.map(({ firewalls }) => ({
                      firewall: firewalls[0],
                      actions: [],
                    })),
                  ),
          ),
        ),
      ),
    );
  yield* waitActions(created.actions ?? []);
  return created.firewall ?? (yield* findByName(input.name));
});

const syncNameAndLabels = Effect.fn(function* (input: {
  firewallId: number;
  observedName: string;
  desiredName: string;
  observedLabels: Record<string, string>;
  desiredLabels: Record<string, string>;
}) {
  const nameChanged = input.observedName !== input.desiredName;
  const { upsert, removed } = diffLabels(
    input.observedLabels,
    input.desiredLabels,
  );
  const labelsChanged = upsert.length > 0 || removed.length > 0;
  if (!nameChanged && !labelsChanged) return;
  yield* Services.firewalls.updateFirewall({
    id: input.firewallId,
    ...(nameChanged ? { name: input.desiredName } : {}),
    ...(labelsChanged ? { labels: input.desiredLabels } : {}),
  });
});

const syncRules = Effect.fn(function* (input: {
  firewallId: number;
  observed: FirewallRule[];
  desired: FirewallRule[];
}) {
  if (rulesEqual(input.observed, input.desired)) return;
  const { actions } = yield* Services.firewallActions.setFirewallRules({
    id: input.firewallId,
    rules: input.desired.map(toWireRule),
  });
  yield* waitActions(actions);
});

const syncApplyTo = Effect.fn(function* (input: {
  firewallId: number;
  observed: ReadonlyArray<GetFirewallResponseFirewallAppliedToItem>;
  desiredIds: number[];
}) {
  const observedIds = new Set(observedServerIds(input.observed));
  const desiredIds = new Set(input.desiredIds);
  const toAdd = [...desiredIds].filter((id) => !observedIds.has(id));
  const toRemove = [...observedIds].filter((id) => !desiredIds.has(id));
  if (toAdd.length > 0) {
    const { actions } =
      yield* Services.firewallActions.applyFirewallToResources({
        id: input.firewallId,
        apply_to: toServerApplyItems(toAdd),
      });
    yield* waitActions(actions);
  }
  if (toRemove.length > 0) {
    const { actions } =
      yield* Services.firewallActions.removeFirewallFromResources({
        id: input.firewallId,
        remove_from: toServerApplyItems(toRemove),
      });
    yield* waitActions(actions);
  }
});

const detachAll = Effect.fn(function* (
  firewallId: number,
  appliedTo: ReadonlyArray<GetFirewallResponseFirewallAppliedToItem>,
) {
  const removeFrom = detachItems(appliedTo);
  if (removeFrom.length === 0) return;
  const result = yield* Services.firewallActions
    .removeFirewallFromResources({
      id: firewallId,
      remove_from: removeFrom,
    })
    .pipe(
      Effect.catchTag(["NotFound", "UnprocessableEntity"], () =>
        Effect.succeed({ actions: [] }),
      ),
    );
  yield* waitActions(result.actions);
});

export const FirewallProvider = () =>
  Provider.succeed(Firewall, {
    stables: ["id", "created"],
    list: Effect.fn(function* () {
      const rows = yield* Services.firewalls.listFirewalls
        .items({ label_selector: alchemyStackSelector, per_page: 50 })
        .pipe(Stream.runCollect);
      return Array.from(rows, toAttrs);
    }),
    diff: Effect.fn(function* ({ id, olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const oldName =
        output?.name ?? (yield* createFirewallName(id, olds?.name));
      const newName = news.name ?? oldName;
      if (oldName !== newName) {
        return { action: "update" } as const;
      }
      if (
        !rulesEqual(desiredRules(olds?.rules), desiredRules(news.rules)) ||
        !recordsEqual(olds?.labels ?? {}, news.labels ?? {})
      ) {
        return { action: "update" } as const;
      }
      const oldIds = desiredServerIds(olds?.applyTo);
      const newIds = desiredServerIds(news.applyTo);
      if (!deepEqual(oldIds, newIds)) {
        return { action: "update" } as const;
      }
      if (output !== undefined) {
        if (!rulesEqual(output.rules, desiredRules(news.rules))) {
          return { action: "update" } as const;
        }
        const outputIds = output.appliedTo.map((item) => item.serverId);
        if (
          !deepEqual(
            [...outputIds].sort((a, b) => a - b),
            newIds,
          )
        ) {
          return { action: "update" } as const;
        }
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const name =
        output?.name ??
        (olds?.name !== undefined
          ? olds.name
          : output !== undefined
            ? undefined
            : yield* createFirewallName(id, olds?.name));
      const observed =
        output?.id !== undefined
          ? ((yield* getById(output.id)) ??
            (name !== undefined ? yield* findByName(name) : undefined) ??
            (yield* findByLabels(id)))
          : name !== undefined
            ? ((yield* findByName(name)) ?? (yield* findByLabels(id)))
            : yield* findByLabels(id);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(observed);
      const ours = yield* hasAlchemyLabels(id, compactLabels(observed.labels));
      return ours ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name =
        news.name ?? output?.name ?? (yield* createFirewallName(id, news.name));
      const labels = yield* desiredLabels(id, news.labels);
      const rules = desiredRules(news.rules);
      const serverIds = desiredServerIds(news.applyTo);

      // Observe — cached id is a hint; cloud state is authoritative.
      let current = yield* observe({ id, name, output });

      // Ensure — create if missing. A Conflict is a name-race; look up
      // the existing firewall and fall through to sync.
      if (current === undefined) {
        yield* ensureFirewall({
          name,
          labels,
          rules,
          serverIds,
        });
      }
      if (current === undefined) {
        current = yield* observe({ id, name, output });
      }
      if (current === undefined) {
        return yield* new FirewallNotCreated({ name });
      }

      // Sync each mutable aspect against observed cloud state.
      yield* syncNameAndLabels({
        firewallId: current.id,
        observedName: current.name,
        desiredName: name,
        observedLabels: compactLabels(current.labels),
        desiredLabels: labels,
      });
      yield* syncRules({
        firewallId: current.id,
        observed: current.rules.map(fromObservedRule),
        desired: rules,
      });
      yield* syncApplyTo({
        firewallId: current.id,
        observed: current.applied_to,
        desiredIds: serverIds,
      });

      const fresh = (yield* getById(current.id)) ?? current;
      return toAttrs(fresh);
    }),
    delete: Effect.fn(function* ({ output }) {
      const id = output.id;
      const observed = yield* getById(id);
      if (observed !== undefined) {
        yield* detachAll(id, observed.applied_to);
      }
      yield* Services.firewalls.deleteFirewall({ id }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("UnprocessableEntity", () =>
          Effect.gen(function* () {
            const again = yield* getById(id);
            if (again === undefined) return;
            yield* detachAll(id, again.applied_to);
            yield* Services.firewalls
              .deleteFirewall({ id })
              .pipe(Effect.catchTag("NotFound", () => Effect.void));
          }),
        ),
      );
    }),
  });
