import * as sasportal from "@distilled.cloud/gcp/sasportal_v1alpha1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_DISPLAY_NAME_LENGTH = 256;
export const DIRECT_CHILDREN = "DIRECT_CHILDREN";

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  if (parts.length >= 4) return parts.slice(0, -2).join("/");
  return "";
};

export const expandName = (value: string, collection: string) => {
  const trimmed = value.replace(/\/+$/, "").trim();
  if (trimmed.includes("/")) return trimmed;
  return `${collection}/${trimmed}`;
};

export const expandCustomer = (value: string) => expandName(value, "customers");

export const expandNode = (value: string) => expandName(value, "nodes");

export const expandPath = (value: string) => value.replace(/\/+$/, "").trim();

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  sameJson([...(left ?? [])].slice().sort(), [...(right ?? [])].slice().sort());

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousParent?: string;
  nextParent?: string;
  extra?: boolean;
}) => {
  if (input.extra === true) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousParent !== undefined &&
    input.nextParent !== undefined &&
    input.previousParent !== input.nextParent
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  return undefined;
};

const markerOf = (
  _labels: Record<string, string>,
  stack: string,
  stage: string,
  id: string,
) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(labels, stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = markerOf(labels, stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
): string => {
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const minMarker = 24;
  const reserved = Math.min(
    trimmed.length + 1,
    Math.max(0, maxLength - minMarker),
  );
  const marker = fitMarker(labels, maxLength - reserved);
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text?.startsWith("[alchemy ")) {
    return { labels: {}, text };
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnership(text);
    if (!hasOwnershipMarker(text)) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const toDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = 40,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    const next = /^[a-z]/.test(generated)
      ? generated
      : `s${generated}`.slice(0, maxLength);
    return next.length > 0 ? next : "s";
  });

export const toSerialNumber = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 16,
      lowercase: true,
    });
    const serial = generated.replace(/[^a-z0-9]/g, "").slice(0, 16);
    return serial.length > 0 ? serial.toUpperCase() : "SN1";
  });

export class DeleteNotConfirmed extends Data.TaggedError(
  "GCP.SasPortal.DeleteNotConfirmed",
)<{}> {}

/** Poll until the resource is gone; fails if it is still readable after ~60s. */
export const waitUntilGone = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
) =>
  get.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (value) => value === undefined,
      times: 30,
    }),
    Effect.flatMap((value): Effect.Effect<void, DeleteNotConfirmed> =>
      value === undefined ? Effect.void : Effect.fail(new DeleteNotConfirmed()),
    ),
  );

export const retryDelete = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
  );

const emptyList = <A>() => Effect.succeed([] as A[]);

const isMissing = <E extends { readonly _tag: string }>(
  error: E,
): error is Extract<E, { readonly _tag: "NotFound" }> =>
  error._tag === "NotFound";

export const collectPages = <
  Page,
  Item,
  E extends { readonly _tag: string },
  R,
>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk) as Item[]),
    Effect.catchIf(isMissing, () => emptyList<Item>()),
  );

export const listCustomers = () =>
  collectPages(
    sasportal.listCustomers.pages({ pageSize: 100 }),
    (page) => page.customers,
  );

export const listCustomerDeployments = (parent: string) =>
  parent.length === 0
    ? emptyList<sasportal.SasPortalDeployment>()
    : collectPages(
        sasportal.listCustomersDeployments.pages({
          parent,
          pageSize: 100,
          filter: DIRECT_CHILDREN,
        }),
        (page) => page.deployments,
      );

export const listCustomerDevices = (parent: string) =>
  parent.length === 0
    ? emptyList<sasportal.SasPortalDevice>()
    : collectPages(
        sasportal.listCustomersDevices.pages({
          parent,
          pageSize: 1000,
        }),
        (page) => page.devices,
      );

export const listCustomerNodes = (parent: string) =>
  parent.length === 0
    ? emptyList<sasportal.SasPortalNode>()
    : collectPages(
        sasportal.listCustomersNodes.pages({
          parent,
          pageSize: 100,
          filter: DIRECT_CHILDREN,
        }),
        (page) => page.nodes,
      );

export const listNodeDevices = (parent: string) =>
  parent.length === 0
    ? emptyList<sasportal.SasPortalDevice>()
    : collectPages(
        sasportal.listNodesDevices.pages({
          parent,
          pageSize: 1000,
        }),
        (page) => page.devices,
      );

export const listNodeNodes = (parent: string) =>
  parent.length === 0
    ? emptyList<sasportal.SasPortalNode>()
    : collectPages(
        sasportal.listNodesNodes.pages({
          parent,
          pageSize: 100,
          filter: DIRECT_CHILDREN,
        }),
        (page) => page.nodes,
      );

export const listCustomerDeploymentDevices = (parent: string) =>
  parent.length === 0
    ? emptyList<sasportal.SasPortalDevice>()
    : collectPages(
        sasportal.listCustomersDeploymentsDevices.pages({
          parent,
          pageSize: 1000,
        }),
        (page) => page.devices,
      );

export const listCustomerNodeDeployments = (parent: string) =>
  parent.length === 0
    ? emptyList<sasportal.SasPortalDeployment>()
    : collectPages(
        sasportal.listCustomersNodesDeployments.pages({
          parent,
          pageSize: 100,
          filter: DIRECT_CHILDREN,
        }),
        (page) => page.deployments,
      );

export const listCustomerNodeDevices = (parent: string) =>
  parent.length === 0
    ? emptyList<sasportal.SasPortalDevice>()
    : collectPages(
        sasportal.listCustomersNodesDevices.pages({
          parent,
          pageSize: 1000,
        }),
        (page) => page.devices,
      );

export const listCustomerNodeNodes = (parent: string) =>
  parent.length === 0
    ? emptyList<sasportal.SasPortalNode>()
    : collectPages(
        sasportal.listCustomersNodesNodes.pages({
          parent,
          pageSize: 100,
          filter: DIRECT_CHILDREN,
        }),
        (page) => page.nodes,
      );

export const listNodeDeployments = (parent: string) =>
  parent.length === 0
    ? emptyList<sasportal.SasPortalDeployment>()
    : collectPages(
        sasportal.listNodesDeployments.pages({
          parent,
          pageSize: 100,
          filter: DIRECT_CHILDREN,
        }),
        (page) => page.deployments,
      );

export const listNodeDeploymentDevices = (parent: string) =>
  parent.length === 0
    ? emptyList<sasportal.SasPortalDevice>()
    : collectPages(
        sasportal.listNodesDeploymentsDevices.pages({
          parent,
          pageSize: 1000,
        }),
        (page) => page.devices,
      );

export const listNodeNodeDeployments = (parent: string) =>
  parent.length === 0
    ? emptyList<sasportal.SasPortalDeployment>()
    : collectPages(
        sasportal.listNodesNodesDeployments.pages({
          parent,
          pageSize: 100,
          filter: DIRECT_CHILDREN,
        }),
        (page) => page.deployments,
      );

export const listNodeNodeDevices = (parent: string) =>
  parent.length === 0
    ? emptyList<sasportal.SasPortalDevice>()
    : collectPages(
        sasportal.listNodesNodesDevices.pages({
          parent,
          pageSize: 1000,
        }),
        (page) => page.devices,
      );

export const listNodeNodeNodes = (parent: string) =>
  parent.length === 0
    ? emptyList<sasportal.SasPortalNode>()
    : collectPages(
        sasportal.listNodesNodesNodes.pages({
          parent,
          pageSize: 100,
          filter: DIRECT_CHILDREN,
        }),
        (page) => page.nodes,
      );

export type LocatedNode = {
  node: sasportal.SasPortalNode;
  parent: string;
};

export const walkNodes = () =>
  Effect.gen(function* () {
    const customers = yield* listCustomers();
    const located: LocatedNode[] = [];
    const seen = new Set<string>();
    const queue: Array<{ parent: string; underCustomer: boolean }> =
      customers.flatMap((customer) =>
        customer.name ? [{ parent: customer.name, underCustomer: true }] : [],
      );
    while (queue.length > 0) {
      const batch = queue.splice(0, queue.length);
      const pages = yield* Effect.forEach(
        batch,
        (item) =>
          (item.underCustomer
            ? listCustomerNodes(item.parent)
            : listNodeNodes(item.parent)
          ).pipe(
            Effect.map((nodes) =>
              nodes.map((node) => ({ node, parent: item.parent })),
            ),
          ),
        { concurrency: 4 },
      );
      for (const entry of pages.flat()) {
        const name = entry.node.name ?? "";
        if (name.length === 0 || seen.has(name)) continue;
        seen.add(name);
        located.push(entry);
        queue.push({ parent: name, underCustomer: false });
      }
    }
    return located;
  });

const catchMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(Effect.catchIf(isMissing, () => Effect.succeed(undefined)));

export const getCustomerDeployment = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(sasportal.getCustomersDeployments({ name }));

export const getCustomerDevice = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(sasportal.getCustomersDevices({ name }));

export const getCustomerNode = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(sasportal.getCustomersNodes({ name }));

export const getNodeDevice = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(sasportal.getNodesDevices({ name }));

export const getNodeNode = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(sasportal.getNodesNodes({ name }));

export const getDeploymentDevice = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(sasportal.getDeploymentsDevices({ name }));

export const getNodeDeployment = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(sasportal.getNodesDeployments({ name }));

export const findOwned = <A>(
  id: string,
  rows: readonly A[],
  displayName: (row: A) => string | undefined,
) =>
  Effect.gen(function* () {
    for (const row of rows) {
      if (yield* ownedByAlchemy(id, displayName(row))) {
        return row;
      }
    }
    return undefined;
  });

export const findOwnedCustomerDeployment = (id: string, parent: string) =>
  Effect.gen(function* () {
    const rows = yield* listCustomerDeployments(parent);
    const match = yield* findOwned(id, rows, (row) => row.displayName);
    return match === undefined ? undefined : { row: match, parent };
  });

export const findOwnedCustomerDevice = (id: string, parent: string) =>
  Effect.gen(function* () {
    const rows = yield* listCustomerDevices(parent);
    const match = yield* findOwned(id, rows, (row) => row.displayName);
    return match === undefined ? undefined : { row: match, parent };
  });

export const findOwnedCustomerNode = (id: string, parent: string) =>
  Effect.gen(function* () {
    const rows = yield* listCustomerNodes(parent);
    const match = yield* findOwned(id, rows, (row) => row.displayName);
    return match === undefined ? undefined : { row: match, parent };
  });

export const findOwnedNodeDevice = (id: string, parent: string) =>
  Effect.gen(function* () {
    const rows = yield* listNodeDevices(parent);
    const match = yield* findOwned(id, rows, (row) => row.displayName);
    return match === undefined ? undefined : { row: match, parent };
  });

export const findOwnedNodeNode = (id: string, parent: string) =>
  Effect.gen(function* () {
    const rows = yield* listNodeNodes(parent);
    const match = yield* findOwned(id, rows, (row) => row.displayName);
    return match === undefined ? undefined : { row: match, parent };
  });

export const findOwnedCustomerDeploymentDevice = (id: string, parent: string) =>
  Effect.gen(function* () {
    const rows = yield* listCustomerDeploymentDevices(parent);
    const match = yield* findOwned(id, rows, (row) => row.displayName);
    return match === undefined ? undefined : { row: match, parent };
  });

export const findOwnedCustomerNodeDeployment = (id: string, parent: string) =>
  Effect.gen(function* () {
    const rows = yield* listCustomerNodeDeployments(parent);
    const match = yield* findOwned(id, rows, (row) => row.displayName);
    return match === undefined ? undefined : { row: match, parent };
  });

export const findOwnedCustomerNodeDevice = (id: string, parent: string) =>
  Effect.gen(function* () {
    const rows = yield* listCustomerNodeDevices(parent);
    const match = yield* findOwned(id, rows, (row) => row.displayName);
    return match === undefined ? undefined : { row: match, parent };
  });

export const findOwnedCustomerNodeNode = (id: string, parent: string) =>
  Effect.gen(function* () {
    const rows = yield* listCustomerNodeNodes(parent);
    const match = yield* findOwned(id, rows, (row) => row.displayName);
    return match === undefined ? undefined : { row: match, parent };
  });

export const findOwnedNodeDeployment = (id: string, parent: string) =>
  Effect.gen(function* () {
    const rows = yield* listNodeDeployments(parent);
    const match = yield* findOwned(id, rows, (row) => row.displayName);
    return match === undefined ? undefined : { row: match, parent };
  });

export const findOwnedNodeDeploymentDevice = (id: string, parent: string) =>
  Effect.gen(function* () {
    const rows = yield* listNodeDeploymentDevices(parent);
    const match = yield* findOwned(id, rows, (row) => row.displayName);
    return match === undefined ? undefined : { row: match, parent };
  });

export const findOwnedNodeNodeDeployment = (id: string, parent: string) =>
  Effect.gen(function* () {
    const rows = yield* listNodeNodeDeployments(parent);
    const match = yield* findOwned(id, rows, (row) => row.displayName);
    return match === undefined ? undefined : { row: match, parent };
  });

export const findOwnedNodeNodeDevice = (id: string, parent: string) =>
  Effect.gen(function* () {
    const rows = yield* listNodeNodeDevices(parent);
    const match = yield* findOwned(id, rows, (row) => row.displayName);
    return match === undefined ? undefined : { row: match, parent };
  });

export const findOwnedNodeNodeNode = (id: string, parent: string) =>
  Effect.gen(function* () {
    const rows = yield* listNodeNodeNodes(parent);
    const match = yield* findOwned(id, rows, (row) => row.displayName);
    return match === undefined ? undefined : { row: match, parent };
  });

export const findDeviceBySerial = (
  rows: readonly sasportal.SasPortalDevice[],
  serialNumber: string | undefined,
) => {
  if (serialNumber === undefined || serialNumber.length === 0) {
    return undefined;
  }
  return rows.find((row) => row.serialNumber === serialNumber);
};

export const scanOwnedCustomerDeployment = (id: string, parent?: string) =>
  Effect.gen(function* () {
    if (parent !== undefined && parent.length > 0) {
      const local = yield* findOwnedCustomerDeployment(id, parent);
      if (local !== undefined) return local;
    }
    const customers = yield* listCustomers();
    for (const customer of customers) {
      if (!customer.name) continue;
      const found = yield* findOwnedCustomerDeployment(id, customer.name);
      if (found !== undefined) return found;
    }
    return undefined;
  });

export const scanOwnedCustomerDevice = (id: string, parent?: string) =>
  Effect.gen(function* () {
    if (parent !== undefined && parent.length > 0) {
      const local = yield* findOwnedCustomerDevice(id, parent);
      if (local !== undefined) return local;
    }
    const customers = yield* listCustomers();
    for (const customer of customers) {
      if (!customer.name) continue;
      const found = yield* findOwnedCustomerDevice(id, customer.name);
      if (found !== undefined) return found;
    }
    return undefined;
  });

export const scanOwnedCustomerNode = (id: string, parent?: string) =>
  Effect.gen(function* () {
    if (parent !== undefined && parent.length > 0) {
      const local = yield* findOwnedCustomerNode(id, parent);
      if (local !== undefined) return local;
    }
    const customers = yield* listCustomers();
    for (const customer of customers) {
      if (!customer.name) continue;
      const found = yield* findOwnedCustomerNode(id, customer.name);
      if (found !== undefined) return found;
    }
    return undefined;
  });

export const scanOwnedNodeDevice = (id: string, parent?: string) =>
  Effect.gen(function* () {
    if (parent !== undefined && parent.length > 0) {
      const local = yield* findOwnedNodeDevice(id, parent);
      if (local !== undefined) return local;
    }
    const nodes = yield* walkNodes();
    for (const entry of nodes) {
      const name = entry.node.name ?? "";
      if (name.length === 0) continue;
      const found = yield* findOwnedNodeDevice(id, name);
      if (found !== undefined) return found;
    }
    return undefined;
  });

export const scanOwnedNodeNode = (id: string, parent?: string) =>
  Effect.gen(function* () {
    if (parent !== undefined && parent.length > 0) {
      const local = yield* findOwnedNodeNode(id, parent);
      if (local !== undefined) return local;
    }
    const nodes = yield* walkNodes();
    for (const entry of nodes) {
      const name = entry.node.name ?? "";
      if (name.length === 0) continue;
      const found = yield* findOwnedNodeNode(id, name);
      if (found !== undefined) return found;
    }
    return undefined;
  });

export type LocatedDeployment = {
  deployment: sasportal.SasPortalDeployment;
  parent: string;
};

export const walkCustomerDeployments = () =>
  Effect.gen(function* () {
    const customers = yield* listCustomers();
    const pages = yield* Effect.forEach(
      customers,
      (customer) => {
        const parent = customer.name ?? "";
        return parent.length === 0
          ? Effect.succeed([] as LocatedDeployment[])
          : listCustomerDeployments(parent).pipe(
              Effect.map((rows) =>
                rows.map((deployment) => ({ deployment, parent })),
              ),
            );
      },
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const walkCustomerNodes = () =>
  Effect.gen(function* () {
    const customers = yield* listCustomers();
    const pages = yield* Effect.forEach(
      customers,
      (customer) => {
        const parent = customer.name ?? "";
        return parent.length === 0
          ? Effect.succeed([] as LocatedNode[])
          : listCustomerNodes(parent).pipe(
              Effect.map((rows) => rows.map((node) => ({ node, parent }))),
            );
      },
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const walkNodeDeployments = () =>
  Effect.gen(function* () {
    const nodes = yield* walkNodes();
    const pages = yield* Effect.forEach(
      nodes,
      (entry) => {
        const parent = entry.node.name ?? "";
        return parent.length === 0
          ? Effect.succeed([] as LocatedDeployment[])
          : listNodeDeployments(parent).pipe(
              Effect.map((rows) =>
                rows.map((deployment) => ({ deployment, parent })),
              ),
            );
      },
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const walkNodeChildren = () =>
  Effect.gen(function* () {
    const nodes = yield* walkNodes();
    const pages = yield* Effect.forEach(
      nodes,
      (entry) => {
        const parent = entry.node.name ?? "";
        return parent.length === 0
          ? Effect.succeed([] as LocatedNode[])
          : listNodeNodes(parent).pipe(
              Effect.map((rows) => rows.map((node) => ({ node, parent }))),
            );
      },
      { concurrency: 4 },
    );
    return pages.flat();
  });

const scanFirst = <A, E, R>(
  parent: string | undefined,
  local: (parent: string) => Effect.Effect<A | undefined, E, R>,
  walk: Effect.Effect<ReadonlyArray<{ name: string }>, E, R>,
) =>
  Effect.gen(function* () {
    if (parent !== undefined && parent.length > 0) {
      const found = yield* local(parent);
      if (found !== undefined) return found;
    }
    const rows = yield* walk;
    for (const row of rows) {
      if (row.name.length === 0) continue;
      const found = yield* local(row.name);
      if (found !== undefined) return found;
    }
    return undefined;
  });

export const scanOwnedCustomerDeploymentDevice = (
  id: string,
  parent?: string,
) =>
  scanFirst(
    parent,
    (next) => findOwnedCustomerDeploymentDevice(id, next),
    walkCustomerDeployments().pipe(
      Effect.map((rows) =>
        rows.map((entry) => ({ name: entry.deployment.name ?? "" })),
      ),
    ),
  );

export const scanOwnedCustomerNodeDeployment = (id: string, parent?: string) =>
  scanFirst(
    parent,
    (next) => findOwnedCustomerNodeDeployment(id, next),
    walkCustomerNodes().pipe(
      Effect.map((rows) =>
        rows.map((entry) => ({ name: entry.node.name ?? "" })),
      ),
    ),
  );

export const scanOwnedCustomerNodeDevice = (id: string, parent?: string) =>
  scanFirst(
    parent,
    (next) => findOwnedCustomerNodeDevice(id, next),
    walkCustomerNodes().pipe(
      Effect.map((rows) =>
        rows.map((entry) => ({ name: entry.node.name ?? "" })),
      ),
    ),
  );

export const scanOwnedCustomerNodeNode = (id: string, parent?: string) =>
  scanFirst(
    parent,
    (next) => findOwnedCustomerNodeNode(id, next),
    walkCustomerNodes().pipe(
      Effect.map((rows) =>
        rows.map((entry) => ({ name: entry.node.name ?? "" })),
      ),
    ),
  );

export const scanOwnedNodeDeployment = (id: string, parent?: string) =>
  scanFirst(
    parent,
    (next) => findOwnedNodeDeployment(id, next),
    walkNodes().pipe(
      Effect.map((rows) =>
        rows.map((entry) => ({ name: entry.node.name ?? "" })),
      ),
    ),
  );

export const scanOwnedNodeDeploymentDevice = (id: string, parent?: string) =>
  scanFirst(
    parent,
    (next) => findOwnedNodeDeploymentDevice(id, next),
    walkNodeDeployments().pipe(
      Effect.map((rows) =>
        rows.map((entry) => ({ name: entry.deployment.name ?? "" })),
      ),
    ),
  );

export const scanOwnedNodeNodeDeployment = (id: string, parent?: string) =>
  scanFirst(
    parent,
    (next) => findOwnedNodeNodeDeployment(id, next),
    walkNodeChildren().pipe(
      Effect.map((rows) =>
        rows.map((entry) => ({ name: entry.node.name ?? "" })),
      ),
    ),
  );

export const scanOwnedNodeNodeDevice = (id: string, parent?: string) =>
  scanFirst(
    parent,
    (next) => findOwnedNodeNodeDevice(id, next),
    walkNodeChildren().pipe(
      Effect.map((rows) =>
        rows.map((entry) => ({ name: entry.node.name ?? "" })),
      ),
    ),
  );

export const scanOwnedNodeNodeNode = (id: string, parent?: string) =>
  scanFirst(
    parent,
    (next) => findOwnedNodeNodeNode(id, next),
    walkNodeChildren().pipe(
      Effect.map((rows) =>
        rows.map((entry) => ({ name: entry.node.name ?? "" })),
      ),
    ),
  );

export type FrequencyRange = {
  /** Lowest frequency of the range in MHz. */
  lowFrequencyMhz?: number;
  /** Highest frequency of the range in MHz. */
  highFrequencyMhz?: number;
};

export type InstallationParams = {
  height?: number;
  horizontalAccuracy?: number;
  antennaGain?: number;
  antennaAzimuth?: number;
  verticalAccuracy?: number;
  latitude?: number;
  heightType?: string;
  indoorDeployment?: boolean;
  eirpCapability?: number;
  antennaModel?: string;
  longitude?: number;
  antennaDowntilt?: number;
  antennaBeamwidth?: number;
  cpeCbsdIndication?: boolean;
};

export type DeviceModel = {
  name?: string;
  softwareVersion?: string;
  firmwareVersion?: string;
  hardwareVersion?: string;
  vendor?: string;
};

export type DeviceAirInterface = {
  supportedSpec?: string;
  radioTechnology?: string;
};

export type DeviceConfig = {
  state?: string;
  installationParams?: InstallationParams;
  measurementCapabilities?: string[];
  model?: DeviceModel;
  airInterface?: DeviceAirInterface;
  callSign?: string;
  category?: string;
  userId?: string;
};

export type DeviceMetadata = {
  interferenceCoordinationGroup?: string;
  commonChannelGroup?: string;
  antennaModel?: string;
};

export type DeviceGrant = {
  grantId?: string;
  maxEirp?: number;
  channelType?: string;
  expireTime?: string;
  lastHeartbeatTransmitExpireTime?: string;
  suspensionReason?: string[];
  frequencyRange?: FrequencyRange;
  state?: string;
};

export const frequencyRangesOf = (
  ranges: sasportal.SasPortalFrequencyRangeList | undefined,
): FrequencyRange[] | undefined => {
  if (ranges === undefined) return undefined;
  return ranges.map((range) => ({
    lowFrequencyMhz: range.lowFrequencyMhz,
    highFrequencyMhz: range.highFrequencyMhz,
  }));
};

export const deviceConfigOf = (
  config: sasportal.SasPortalDeviceConfig | undefined,
): DeviceConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    state: config.state,
    installationParams: config.installationParams,
    measurementCapabilities: config.measurementCapabilities,
    model: config.model,
    airInterface: config.airInterface,
    callSign: config.callSign,
    category: config.category,
    userId: config.userId,
  };
};

export const deviceMetadataOf = (
  metadata: sasportal.SasPortalDeviceMetadata | undefined,
): DeviceMetadata | undefined => {
  if (metadata === undefined) return undefined;
  return {
    interferenceCoordinationGroup: metadata.interferenceCoordinationGroup,
    commonChannelGroup: metadata.commonChannelGroup,
    antennaModel: metadata.antennaModel,
  };
};

export const deviceGrantsOf = (
  grants: sasportal.SasPortalDeviceGrantList | undefined,
): DeviceGrant[] | undefined => {
  if (grants === undefined) return undefined;
  return grants.map((grant) => ({
    grantId: grant.grantId,
    maxEirp: grant.maxEirp,
    channelType: grant.channelType,
    expireTime: grant.expireTime,
    lastHeartbeatTransmitExpireTime: grant.lastHeartbeatTransmitExpireTime,
    suspensionReason: grant.suspensionReason,
    frequencyRange: grant.frequencyRange,
    state: grant.state,
  }));
};

export const deviceBody = (input: {
  displayName: string;
  serialNumber?: string;
  fccId?: string;
  grantRangeAllowlists?: FrequencyRange[];
  preloadedConfig?: DeviceConfig;
  deviceMetadata?: DeviceMetadata;
}): sasportal.SasPortalDevice => ({
  displayName: input.displayName,
  serialNumber: input.serialNumber,
  fccId: input.fccId,
  grantRangeAllowlists: input.grantRangeAllowlists,
  preloadedConfig: input.preloadedConfig,
  deviceMetadata: input.deviceMetadata,
});

export const signedDeviceBody = (input: {
  encodedDevice: string;
  installerId: string;
}): sasportal.SasPortalCreateSignedDeviceRequest => ({
  encodedDevice: input.encodedDevice,
  installerId: input.installerId,
});

export const decodeSignedDevice = (encodedDevice: string) =>
  Effect.sync(() => {
    const parts = encodedDevice.split(".");
    if (parts.length < 2) return undefined;
    try {
      const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
      return JSON.parse(json) as sasportal.SasPortalDevice;
    } catch {
      return undefined;
    }
  });
