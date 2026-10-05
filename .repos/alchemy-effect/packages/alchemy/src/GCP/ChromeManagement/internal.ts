import * as chromemanagement from "@distilled.cloud/gcp/chromemanagement_v1";
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

/** Optional deploy-time setting from the ConfigProvider (env by default). */
const optionalSetting = (key: string) =>
  Effect.gen(function* () {
    const value = yield* Config.option(Config.String(key));
    return Option.getOrUndefined(value)?.trim() || undefined;
  });

export const CUSTOMER_PREFIX = "customers/";
export const MY_CUSTOMER = "customers/my_customer";
export const MAX_DISPLAY_NAME_LENGTH = 256;
export const MAX_CONNECTOR_CONFIG_ID_LENGTH = 63;
export const PROBE_CUSTOMER = "customers/0";
export const PROBE_CONNECTOR_CONFIG = `${PROBE_CUSTOMER}/connectorConfigs/alchemy-missing`;

const INPUT_ONLY_KEYS = new Set(["apiKey", "hecToken"]);

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

export const toConnectorConfigName = (
  parent: string,
  connectorConfigId?: string,
) => {
  if (
    connectorConfigId !== undefined &&
    connectorConfigId.includes("/connectorConfigs/")
  ) {
    return normalizeName(connectorConfigId);
  }
  const customer = toCustomerName(parent);
  if (
    connectorConfigId !== undefined &&
    connectorConfigId.length > 0 &&
    customer.length > 0
  ) {
    return `${customer}/connectorConfigs/${lastSegment(connectorConfigId)}`;
  }
  return "";
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const replaceOnIdentity = (input: {
  previousParent?: string;
  nextParent: string;
  previousId?: string;
  nextId?: string;
  previousType?: string;
  nextType?: string;
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
  if (
    input.previousType !== undefined &&
    input.nextType !== undefined &&
    input.previousType !== input.nextType
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  return undefined;
};

const stripInputOnly = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripInputOnly);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (INPUT_ONLY_KEYS.has(key)) continue;
    out[key] = stripInputOnly(child);
  }
  return out;
};

export const visibleDetails = (
  details:
    | chromemanagement.GoogleChromeManagementVersionsV1ConnectorConfigDetails
    | undefined,
) =>
  stripInputOnly(details) as
    | chromemanagement.GoogleChromeManagementVersionsV1ConnectorConfigDetails
    | undefined;

const secretSlice = (
  details:
    | chromemanagement.GoogleChromeManagementVersionsV1ConnectorConfigDetails
    | undefined,
) => {
  if (!details) return undefined;
  return {
    splunkHecToken: details.splunkConfig?.hecToken,
    paloAltoApiKey: details.paloAltoNetworksConfig?.apiKey,
    crowdStrikeApiKey: details.crowdStrikeConfig?.apiKey,
    crowdStrikeFalconApiKey: details.crowdStrikeFalconNextGenConfig?.apiKey,
    crowdStrikeXdrApiKey: details.crowdStrikeXdrConfig?.apiKey,
    googleSecOpsApiKey: details.googleSecOpsConfig?.apiKey,
  };
};

export const detailsNeedSync = (
  observed:
    | chromemanagement.GoogleChromeManagementVersionsV1ConnectorConfigDetails
    | undefined,
  desired:
    | chromemanagement.GoogleChromeManagementVersionsV1ConnectorConfigDetails
    | undefined,
  previous:
    | chromemanagement.GoogleChromeManagementVersionsV1ConnectorConfigDetails
    | undefined,
) =>
  !jsonEqual(visibleDetails(observed), visibleDetails(desired)) ||
  (previous !== undefined &&
    !jsonEqual(secretSlice(desired), secretSlice(previous)));

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
  maxLength = MAX_DISPLAY_NAME_LENGTH,
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

export const toConnectorConfigId = (
  id: string,
  requested: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return lastSegment(requested);
    }
    if (existing !== undefined && existing.length > 0) {
      return lastSegment(existing);
    }
    return yield* createPhysicalName({
      id,
      maxLength: MAX_CONNECTOR_CONFIG_ID_LENGTH,
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

export const getConnectorConfig = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : chromemanagement
        .getCustomersConnectorConfigs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listConnectorConfigsAt = (parent: string) =>
  parent.length === 0
    ? emptyList<chromemanagement.GoogleChromeManagementVersionsV1ConnectorConfig>()
    : collectPages(
        chromemanagement.listCustomersConnectorConfigs.pages({
          parent: toCustomerName(parent),
          pageSize: 100,
        }),
        (page) => page.connectorConfigs,
      ).pipe(
        Effect.catchTag("NotFound", () =>
          emptyList<chromemanagement.GoogleChromeManagementVersionsV1ConnectorConfig>(),
        ),
      );

/** `my_customer` plus any customers listed in the Chrome Management settings. */
export const configuredCustomers = () =>
  Effect.gen(function* () {
    const names = new Set<string>();
    names.add(MY_CUSTOMER);
    for (const key of [
      "GCP_CHROMEMANAGEMENT_CUSTOMER",
      "GCP_CHROMEMANAGEMENT_CUSTOMER_ID",
      "GCP_CHROMEMANAGEMENT_CUSTOMERS",
    ]) {
      const raw = yield* optionalSetting(key);
      for (const part of (raw ?? "").split(/[,\s]+/)) {
        const name = toCustomerName(part);
        if (name.length > 0) names.add(name);
      }
    }
    return [...names];
  });

export const findOwnedConnectorConfig = (id: string, parent?: string) =>
  Effect.gen(function* () {
    const parents =
      parent !== undefined && parent.length > 0
        ? [toCustomerName(parent)]
        : yield* configuredCustomers();
    for (const next of parents) {
      const rows = yield* listConnectorConfigsAt(next);
      for (const row of rows) {
        if (yield* ownedByAlchemy(id, row.displayName)) {
          return row;
        }
      }
    }
    return undefined;
  });

export const findConnectorConfigByName = (
  displayName: string,
  parent: string,
) =>
  Effect.gen(function* () {
    const rows = yield* listConnectorConfigsAt(parent);
    return rows.find((row) => row.displayName === displayName);
  });

export const listOwnedConnectorConfigs = () =>
  Effect.gen(function* () {
    const parents = yield* configuredCustomers();
    const pages = yield* Effect.forEach(
      parents,
      (parent) => listConnectorConfigsAt(parent),
      { concurrency: 4 },
    );
    return pages.flat().filter((row) => hasOwnershipMarker(row.displayName));
  });
