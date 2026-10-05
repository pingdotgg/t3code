import * as androiddeviceprovisioning from "@distilled.cloud/gcp/androiddeviceprovisioning_v1";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const CUSTOMER_PREFIX = "customers/";
export const MAX_CONFIGURATION_NAME_LENGTH = 100;
export const DEFAULT_IS_DEFAULT = false;
export const PROBE_CUSTOMER = "customers/0";
export const PROBE_CONFIGURATION = `${PROBE_CUSTOMER}/configurations/0`;
export const ANDROID_DEVICE_POLICY_PACKAGE =
  "com.google.android.apps.work.clouddpc";

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

export const normalizeName = (value: string) =>
  value.replace(/\/+$/, "").trim();

export const toCustomerName = (value: string) => {
  const trimmed = normalizeName(value);
  if (trimmed.length === 0) return "";
  const customersIdx = trimmed.lastIndexOf("/customers/");
  if (customersIdx >= 0) {
    const rest = trimmed.slice(customersIdx + "/customers/".length);
    const id = rest.split("/")[0] ?? "";
    return id.length > 0 ? `${CUSTOMER_PREFIX}${id}` : "";
  }
  if (trimmed.startsWith(CUSTOMER_PREFIX)) {
    const id = trimmed.slice(CUSTOMER_PREFIX.length).split("/")[0] ?? "";
    return id.length > 0 ? `${CUSTOMER_PREFIX}${id}` : trimmed;
  }
  return `${CUSTOMER_PREFIX}${lastSegment(trimmed)}`;
};

export const toConfigurationName = (
  parent: string,
  configurationId?: string,
) => {
  if (
    configurationId !== undefined &&
    configurationId.includes("/configurations/")
  ) {
    return normalizeName(configurationId);
  }
  const customer = toCustomerName(parent);
  if (
    configurationId !== undefined &&
    configurationId.length > 0 &&
    customer.length > 0
  ) {
    return `${customer}/configurations/${lastSegment(configurationId)}`;
  }
  return "";
};

export const toDpcName = (parent: string, value: string) => {
  const trimmed = normalizeName(value);
  if (trimmed.includes("/dpcs/")) return trimmed;
  const customer = toCustomerName(parent);
  if (customer.length === 0 || trimmed.length === 0) return trimmed;
  return `${customer}/dpcs/${lastSegment(trimmed)}`;
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameBoolean = (
  left: boolean | undefined,
  right: boolean | undefined,
) => left === right;

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const replaceOnIdentity = (input: {
  previousParent?: string;
  nextParent: string;
  previousId?: string;
  nextId?: string;
}) => {
  if (
    input.previousParent !== undefined &&
    input.previousParent.length > 0 &&
    toCustomerName(input.previousParent) !== toCustomerName(input.nextParent)
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    lastSegment(input.previousId) !== lastSegment(input.nextId)
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  return undefined;
};

const markerOf = (stack: string, stage: string, id: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(stack, stage, id);
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
    marker = markerOf(stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_CONFIGURATION_NAME_LENGTH,
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
  maxLength = MAX_CONFIGURATION_NAME_LENGTH,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested.slice(0, maxLength);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing.slice(0, maxLength);
    }
    return yield* createPhysicalName({
      id,
      maxLength: Math.min(40, maxLength),
      lowercase: true,
    });
  });

const emptyList = <A>() => Effect.succeed([] as A[]);

export const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const getConfiguration = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : androiddeviceprovisioning
        .getCustomersConfigurations({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listConfigurationsAt = (parent: string) =>
  parent.length === 0
    ? emptyList<androiddeviceprovisioning.Configuration>()
    : androiddeviceprovisioning
        .listCustomersConfigurations({ parent: toCustomerName(parent) })
        .pipe(
          Effect.map((page) => page.configurations ?? []),
          Effect.catchTag("NotFound", () =>
            emptyList<androiddeviceprovisioning.Configuration>(),
          ),
        );

export const listDpcsAt = (parent: string) =>
  parent.length === 0
    ? emptyList<androiddeviceprovisioning.Dpc>()
    : androiddeviceprovisioning
        .listCustomersDpcs({ parent: toCustomerName(parent) })
        .pipe(
          Effect.map((page) => page.dpcs ?? []),
          Effect.catchTag("NotFound", () =>
            emptyList<androiddeviceprovisioning.Dpc>(),
          ),
        );

export const pickDpcName = (parent: string) =>
  Effect.gen(function* () {
    const dpcs = yield* listDpcsAt(parent);
    const preferred = dpcs.find(
      (dpc) => dpc.packageName === ANDROID_DEVICE_POLICY_PACKAGE && dpc.name,
    );
    return preferred?.name ?? dpcs.find((dpc) => dpc.name)?.name;
  });

/** Whitespace/comma-separated list setting from the ConfigProvider (env by default). */
const listSetting = (keys: readonly string[]) =>
  Effect.gen(function* () {
    const values: string[] = [];
    for (const key of keys) {
      const raw = Option.getOrUndefined(
        yield* Config.option(Config.String(key)),
      )?.trim();
      if (!raw) continue;
      for (const part of raw.split(/[,\s]+/)) {
        if (part.length > 0) values.push(part);
      }
    }
    return values;
  });

/** Extra customers for `list` (nuke), e.g. `GCP_ANDROIDDEVICEPROVISIONING_CUSTOMERS`. */
export const configuredCustomers = () =>
  listSetting([
    "GCP_ANDROIDDEVICEPROVISIONING_CUSTOMER",
    "GCP_ANDROIDDEVICEPROVISIONING_CUSTOMER_ID",
    "GCP_ANDROIDDEVICEPROVISIONING_CUSTOMERS",
  ]).pipe(
    Effect.map((values) => [
      ...new Set(values.map(toCustomerName).filter((name) => name.length > 0)),
    ]),
  );

export const listCustomersAt = () =>
  collectPages(
    androiddeviceprovisioning.listCustomers.pages({ pageSize: 100 }),
    (page) => page.customers,
  ).pipe(
    Effect.catchTag("NotFound", () =>
      emptyList<androiddeviceprovisioning.Company>(),
    ),
  );

export const listCustomerNames = () =>
  Effect.gen(function* () {
    const configured = yield* configuredCustomers();
    const names = new Set(configured);
    const listed = yield* listCustomersAt();
    for (const company of listed) {
      const fromName = company.name ? toCustomerName(company.name) : "";
      const fromId = company.companyId ? toCustomerName(company.companyId) : "";
      if (fromName.length > 0) names.add(fromName);
      else if (fromId.length > 0) names.add(fromId);
    }
    return [...names];
  });

export const findOwnedConfiguration = (id: string, parent: string) =>
  Effect.gen(function* () {
    const rows = yield* listConfigurationsAt(parent);
    for (const row of rows) {
      if (yield* ownedByAlchemy(id, row.configurationName)) {
        return row;
      }
    }
    return undefined;
  });

export const findConfigurationByName = (
  configurationName: string,
  parent: string,
) =>
  Effect.gen(function* () {
    const rows = yield* listConfigurationsAt(parent);
    return rows.find((row) => row.configurationName === configurationName);
  });

export const listOwnedConfigurations = () =>
  Effect.gen(function* () {
    const parents = yield* listCustomerNames();
    const pages = yield* Effect.forEach(
      parents,
      (parent) => listConfigurationsAt(parent),
      { concurrency: 4 },
    );
    return pages
      .flat()
      .filter((row) => hasOwnershipMarker(row.configurationName));
  });
