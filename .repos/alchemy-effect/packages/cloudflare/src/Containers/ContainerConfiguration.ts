import type * as Containers from "@distilled.cloud/cloudflare/containers";
import { deepEqual } from "alchemy/Diff";
import * as Output from "alchemy/Output";
import { normalizeNulls } from "alchemy/Util/stable";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type {
  AnyContainerApplicationProps,
  ContainerApplication,
  DevContainerImage,
  DurableObjectApplicationSettings,
  DurableObjectContainerProps,
} from "./ContainerApplication.ts";
import type { DurableObjectApplication } from "./DurableObjectApplication.ts";

export class ContainerConfigurationError extends Data.TaggedError("ContainerConfigurationError")<{
  readonly message: string;
}> {}

export class ContainerImagePreparationError extends Data.TaggedError(
  "ContainerImagePreparationError",
)<{
  readonly image: string;
  readonly status: "pending" | "error";
  readonly message: string;
}> {}

/**
 * Two Containers bound to the same Durable Object class declare different
 * values for one application-wide setting. The class has one container
 * application, so the declarations must agree (or only one may declare it).
 */
export class ContainerApplicationSettingsConflict extends Data.TaggedError(
  "ContainerApplicationSettingsConflict",
)<{
  readonly className: string;
  readonly setting: keyof DurableObjectApplicationSettings;
  readonly containers: ReadonlyArray<string>;
  readonly message: string;
}> {}

/**
 * The Containers bound to one Durable Object class cannot be merged into the
 * class's single container entry: two images share a key, the class mixes a
 * fleet Container with Durable Object-managed ones, or it exceeds Cloudflare's
 * image limit.
 */
export class DurableObjectContainerConflict extends Data.TaggedError(
  "DurableObjectContainerConflict",
)<{
  readonly className: string;
  readonly message: string;
}> {}

/**
 * A Durable Object-managed Container was bound on an async Worker outside a
 * Durable Object binding, or a Durable Object binding lists a Container it
 * cannot attach. Durable Object-managed Containers attach to a class through
 * `Cloudflare.DurableObject(className, { containers })`.
 */
export class DurableObjectContainerBindingError extends Data.TaggedError(
  "DurableObjectContainerBindingError",
)<{
  readonly bindingName: string;
  readonly message: string;
}> {}

/**
 * An async `Cloudflare.DurableObject(className, { containers })` binding
 * attaches Containers to a class the same Worker implements as an
 * Effect-native Durable Object. Effect-native classes `yield*` their
 * Containers instead.
 */
export class DurableObjectContainersOnEffectNativeClass extends Data.TaggedError(
  "DurableObjectContainersOnEffectNativeClass",
)<{
  readonly className: string;
  readonly message: string;
}> {}

/**
 * Fail when an async binding's `containers` target a class the Worker
 * implements as an Effect-native Durable Object.
 */
export const assertBindingContainersOnAsyncClasses = (
  rows: ReadonlyArray<{ readonly className: string; readonly attachedBy?: "binding" }>,
  effectNativeClasses: Iterable<string>,
) => {
  const effectNative = new Set(effectNativeClasses);
  const row = rows.find((row) => row.attachedBy === "binding" && effectNative.has(row.className));
  return row === undefined
    ? Effect.void
    : Effect.fail(
        new DurableObjectContainersOnEffectNativeClass({
          className: row.className,
          message: `Durable Object class '${row.className}' is an Effect-native Durable Object, so it cannot take containers from Cloudflare.DurableObject("${row.className}", { containers }). Bind each Container inside the Durable Object with \`yield*\` instead, and remove the containers prop.`,
        }),
      );
};

/** Cloudflare's limits for the `images` map of a Durable Object class. */
const MAX_NAMED_IMAGES = 100;
const MAX_IMAGE_NAME_LENGTH = 128;

/**
 * Fleet-scheduled settings that have no meaning when the Durable Object picks
 * the image and instance size at `start()` time.
 */
const FLEET_ONLY_PROPS = [
  "name",
  "className",
  "main",
  "instanceType",
  "instances",
  "maxInstances",
  "vcpu",
  "memory",
  "memoryMib",
  "disk",
  "env",
  "environmentVariables",
  "secrets",
  "labels",
  "network",
  "command",
  "entrypoint",
  "dns",
  "ports",
  "checks",
  "constraints",
  "affinities",
  "rollout",
  "registryId",
  "sshPublicKeyIds",
] as const satisfies ReadonlyArray<keyof AnyContainerApplicationProps>;

export const isDurableObjectContainer = (
  props: AnyContainerApplicationProps,
): props is DurableObjectContainerProps => props.schedulingPolicy === "durable_object";

const invalid = (message: string) => Effect.fail(new ContainerConfigurationError({ message }));

/** Validate a bounded preparation deadline before publishing any images. */
export const imagePreparationTimeoutMillis = (timeout: Duration.Input = "30 minutes") =>
  Effect.try({
    try: () => {
      const millis = Duration.toMillis(timeout);
      if (!Number.isFinite(millis) || millis <= 0) throw new Error("Invalid timeout");
      return millis;
    },
    catch: () =>
      new ContainerConfigurationError({
        message: "imagePreparationTimeout must be a finite, positive duration.",
      }),
  });

/**
 * Validate container props before publishing images or touching the hosting
 * Worker. Reject switches between fleet scheduling and Durable Object scheduling.
 */
export const validateContainerConfiguration = Effect.fn(function* (
  props: AnyContainerApplicationProps,
  deployedPolicy?: string,
) {
  const policy = props.schedulingPolicy ?? "default";
  if (
    deployedPolicy !== undefined &&
    (deployedPolicy === "durable_object") !== (policy === "durable_object")
  ) {
    return yield* invalid(
      "A container cannot switch between fleet and Durable Object scheduling in place. Declare a new container application and Durable Object class, then move traffic to the new namespace. Existing Durable Object storage is not transferred.",
    );
  }

  // `images` was removed: one Container is one image. Untyped or
  // Effect-produced props can still carry it.
  if ((props as { images?: unknown }).images !== undefined) {
    return yield* invalid(
      "Container property 'images' was removed. Declare one Cloudflare.Container per image with schedulingPolicy: 'durable_object' and bind each one to the Durable Object; the image key is the Container's id.",
    );
  }

  if (!isDurableObjectContainer(props)) return;

  yield* imagePreparationTimeoutMillis(props.imagePreparationTimeout);
  if (
    props.image !== undefined &&
    (props.context !== undefined || props.dockerfile !== undefined)
  ) {
    return yield* invalid(
      "A Durable Object-managed container declares one image source: `image`, or `context`/`dockerfile`.",
    );
  }

  // The union type already forbids these, but untyped or Effect-produced
  // props can still carry them.
  const loose: AnyContainerApplicationProps = props;
  const unsupported = FLEET_ONLY_PROPS.find((key) => loose[key] !== undefined);
  if (unsupported !== undefined) {
    return yield* invalid(
      `Container property '${unsupported}' is not supported with schedulingPolicy: 'durable_object'. The application is named and owned by the Durable Object class: attach the Container with Cloudflare.DurableObject(className, { containers }) on an async Worker, or yield it inside an Effect-native Durable Object. Pass per-instance settings to start().`,
    );
  }
});

/** Whether a Durable Object-managed Container declares an image to publish. */
export const hasImageSource = (props: DurableObjectContainerProps) =>
  props.image !== undefined || props.context !== undefined || props.dockerfile !== undefined;

/** Read the scheduling policy off a declared Container resource's props. */
export const isDurableObjectContainerResource = (container: ContainerApplication) => {
  const props = container.Props as { schedulingPolicy?: unknown } | undefined;
  return props?.schedulingPolicy === "durable_object";
};

/** The application-wide settings a Container contributes to its Durable Object class. */
export const containerApplicationSettings = (container: ContainerApplication) => {
  const props = container.Props as DurableObjectApplicationSettings | undefined;
  return {
    ssh: props?.ssh,
    authorizedKeys: props?.authorizedKeys,
    observability: props?.observability,
  };
};

const SETTING_KEYS = ["ssh", "authorizedKeys", "observability"] as const;

/**
 * Merge the application-wide settings every bound Container declares. A
 * setting declared by several Containers must have the same value.
 */
export const mergeApplicationSettings = (
  className: string,
  contributions: ReadonlyArray<{
    readonly id: string;
    readonly settings: DurableObjectApplicationSettings | undefined;
  }>,
) =>
  Effect.gen(function* () {
    const merged: DurableObjectApplicationSettings = {};
    for (const setting of SETTING_KEYS) {
      const declared = contributions.flatMap(({ id, settings }) => {
        const value = normalizeNulls(settings?.[setting]);
        return value === undefined ? [] : [{ id, value }];
      });
      const [first] = declared;
      if (first === undefined) continue;
      const conflicting = declared.find(({ value }) => !deepEqual(value, first.value));
      if (conflicting !== undefined) {
        return yield* new ContainerApplicationSettingsConflict({
          className,
          setting,
          containers: declared.map(({ id }) => id),
          message: `Containers '${first.id}' and '${conflicting.id}' declare different '${setting}' for Durable Object class '${className}'. A class has one container application, so its Containers must agree on application-wide settings; declare '${setting}' on one Container or give them the same value.`,
        });
      }
      Object.assign(merged, { [setting]: first.value });
    }
    return merged;
  });

/**
 * One row of a Worker's `containers` binding data: the container a Durable
 * Object class is backed by.
 */
export interface WorkerContainerRow {
  readonly className: string;
  /** Set when an async `Cloudflare.DurableObject(name, { containers })` binding contributed the row. */
  readonly attachedBy?: "binding";
  /** Application name, set for a Durable Object-managed class. */
  readonly name?: string;
  /** Prepared images keyed by Container id (Durable Object-managed). */
  readonly images?: Record<string, string>;
  /** Local image sources keyed by Container id (Durable Object-managed). */
  readonly devImages?: Record<string, DevContainerImage>;
  /** The fleet container's local image. */
  readonly dev: DevContainerImage | undefined;
  readonly hash: string | undefined;
}

const isDurableObjectRow = (row: Pick<WorkerContainerRow, "name" | "images" | "devImages">) =>
  row.name !== undefined || row.images !== undefined || row.devImages !== undefined;

const mergeImageMaps = <V>(
  className: string,
  label: string,
  maps: ReadonlyArray<Record<string, V> | undefined>,
) =>
  Effect.gen(function* () {
    if (maps.every((map) => map === undefined)) return undefined;
    const merged: Record<string, V> = {};
    for (const map of maps) {
      for (const [key, value] of Object.entries(map ?? {})) {
        if (key in merged && !deepEqual(merged[key], value)) {
          return yield* new DurableObjectContainerConflict({
            className,
            message: `Two Containers bound to Durable Object class '${className}' publish different ${label} under the key '${key}'. The image key is the Container's id, so give each Container a distinct id.`,
          });
        }
        merged[key] = value;
      }
    }
    return merged;
  });

/**
 * Merge a Worker's `containers` rows into one entry per Durable Object class.
 * A Durable Object-managed class unions the images of every bound Container;
 * a fleet class is backed by exactly one Container.
 */
export const mergeWorkerContainers = <
  Row extends Partial<WorkerContainerRow> & { className: string },
>(
  rows: ReadonlyArray<Row>,
) =>
  Effect.gen(function* () {
    const byClass = new Map<string, Row[]>();
    for (const row of rows) {
      const existing = byClass.get(row.className);
      if (existing) existing.push(row);
      else byClass.set(row.className, [row]);
    }
    const merged: Row[] = [];
    for (const [className, classRows] of byClass) {
      const [first, ...rest] = classRows as [Row, ...Row[]];
      const managed = classRows.filter(isDurableObjectRow);
      if (managed.length === 0) {
        // Fleet: rows for the same Container collapse; distinct ones conflict.
        if (rest.some((row) => !deepEqual(row, first))) {
          return yield* new DurableObjectContainerConflict({
            className,
            message: `Durable Object class '${className}' is bound to more than one fleet Container. Only Durable Object-managed Containers (schedulingPolicy: 'durable_object') can share a class.`,
          });
        }
        merged.push(first);
        continue;
      }
      if (managed.length !== classRows.length) {
        return yield* new DurableObjectContainerConflict({
          className,
          message: `Durable Object class '${className}' mixes a fleet Container with Durable Object-managed Containers. Every Container bound to one class must use schedulingPolicy: 'durable_object'.`,
        });
      }
      const names = [
        ...new Set(managed.flatMap((row) => (row.name === undefined ? [] : [row.name]))),
      ];
      if (names.length > 1) {
        return yield* new DurableObjectContainerConflict({
          className,
          message: `Durable Object class '${className}' resolves to more than one container application (${names.join(", ")}).`,
        });
      }
      const images = yield* mergeImageMaps(
        className,
        "images",
        managed.map((row) => row.images),
      );
      const devImages = yield* mergeImageMaps(
        className,
        "local images",
        managed.map((row) => row.devImages),
      );
      const keys = Object.keys(images ?? devImages ?? {});
      if (keys.length > MAX_NAMED_IMAGES) {
        return yield* new DurableObjectContainerConflict({
          className,
          message: `Durable Object class '${className}' is bound to ${keys.length} container images; Cloudflare allows at most ${MAX_NAMED_IMAGES}.`,
        });
      }
      const badKey = keys.find((key) => key.length === 0 || key.length > MAX_IMAGE_NAME_LENGTH);
      if (badKey !== undefined) {
        return yield* new DurableObjectContainerConflict({
          className,
          message: `Container id '${badKey}' is used as an image key and must contain between 1 and ${MAX_IMAGE_NAME_LENGTH} characters.`,
        });
      }
      const hashes = managed.flatMap((row) => (row.hash === undefined ? [] : [row.hash])).sort();
      merged.push({
        ...first,
        name: names[0],
        images,
        devImages,
        dev: undefined,
        hash: hashes.length === 0 ? undefined : hashes.join(","),
      });
    }
    return merged;
  });

/**
 * The `containers` entry a fleet Container contributes to the Durable Object
 * class it backs.
 */
export const workerContainerBinding = (className: string, application: ContainerApplication) => ({
  className,
  dev: application.dev,
  hash: application.hash.pipe(Output.map((hash) => hash?.image)),
});

/**
 * The `containers` entry a Durable Object-managed Container contributes to
 * its class: the class's application name plus this Container's one image,
 * keyed by the Container's id. The Worker merges every entry of the class.
 */
export const durableObjectContainerBinding = (
  className: string,
  application: DurableObjectApplication,
  container: ContainerApplication,
) => {
  const key = container.LogicalId;
  return {
    className,
    name: application.applicationName,
    images: container.image.pipe(
      Output.map((image): Record<string, string> => (image === undefined ? {} : { [key]: image })),
    ),
    devImages: container.dev.pipe(
      Output.map((dev): Record<string, DevContainerImage> =>
        dev === undefined ? {} : { [key]: dev },
      ),
    ),
    dev: undefined,
    hash: container.hash.pipe(Output.map((hash) => hash?.image)),
  };
};

/**
 * Converge declared settings and reset settings removed from a prior declaration.
 * Omitted settings on new or adopted applications remain unmanaged.
 */
export const durableObjectSettingsPatch = (
  desired: DurableObjectApplicationSettings,
  previous: DurableObjectApplicationSettings | undefined,
  observed: Pick<Containers.GetContainerApplicationResponse, "configuration" | "observability">,
): Pick<Containers.UpdateContainerApplicationRequest, "configuration" | "observability"> => {
  const configuration: Containers.DurableObjectContainerConfiguration = {
    // Cloudflare names the SSH setting after the CLI that connects to it.
    ...(desired.ssh !== undefined
      ? { wranglerSsh: desired.ssh }
      : previous?.ssh !== undefined
        ? { wranglerSsh: { enabled: false } }
        : {}),
    ...(desired.authorizedKeys !== undefined
      ? { authorizedKeys: desired.authorizedKeys }
      : previous?.authorizedKeys !== undefined
        ? { authorizedKeys: [] }
        : {}),
  };
  const observability =
    desired.observability ??
    (previous?.observability !== undefined ? { logs: { enabled: false } } : undefined);
  const configurationChanged = Object.entries(configuration).some(
    ([key, value]) =>
      !deepEqual(
        value,
        normalizeNulls(observed.configuration?.[key as keyof typeof configuration]),
      ),
  );
  return {
    ...(configurationChanged ? { configuration } : {}),
    ...(observability !== undefined &&
    !deepEqual(observability, normalizeNulls(observed.observability))
      ? { observability }
      : {}),
  };
};

/** Common attributes before a Durable Object-managed application exists remotely. */
export const durableObjectPlaceholder = (
  identity: Pick<
    ContainerApplication["Attributes"],
    "applicationId" | "applicationName" | "accountId" | "createdAt" | "observability"
  >,
): ContainerApplication["Attributes"] => ({
  ...identity,
  schedulingPolicy: "durable_object",
  instances: undefined,
  maxInstances: undefined,
  constraints: undefined,
  affinities: undefined,
  configuration: {},
  durableObjects: undefined,
  version: undefined,
  dev: undefined,
});
