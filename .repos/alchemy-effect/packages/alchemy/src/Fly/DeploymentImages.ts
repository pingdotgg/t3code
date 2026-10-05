import type { FlyMachineConfig } from "@distilled.cloud/fly-io/machines";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { alchemyMetadataKeys as keys } from "./Metadata.ts";

const ImageSet = Schema.Array(
  Schema.Struct({ name: Schema.String, image: Schema.String }),
);
export type ContainerImagePin = { name: string; image: string };

/** Blue/green needs immutable image references that survive a crash. */
export const isImmutableImage = (image: string): boolean =>
  /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-fA-F0-9]{64}$/.test(image);

const canonical = (pins: readonly ContainerImagePin[]): ContainerImagePin[] =>
  [...pins].sort((a, b) => a.name.localeCompare(b.name));

const valid = (pins: readonly ContainerImagePin[]): boolean =>
  pins.length > 0 &&
  new Set(pins.map(({ name }) => name)).size === pins.length &&
  pins.every(
    ({ name, image }) => name.trim().length > 0 && isImmutableImage(image),
  );

export const pinsFromConfig = (
  config: FlyMachineConfig | undefined,
): ContainerImagePin[] | undefined => {
  const containers = config?.containers;
  if (!containers?.length) return undefined;
  const pins = containers.map(({ name, image }) => ({
    name: name ?? "",
    image: image ?? "",
  }));
  return valid(pins) ? canonical(pins) : undefined;
};

export const encodeImageSet = (
  pins: readonly ContainerImagePin[],
): string | undefined =>
  valid(pins) ? JSON.stringify(canonical(pins)) : undefined;

export const decodeImageSet = (
  raw: string | undefined,
): ContainerImagePin[] | undefined => {
  if (raw === undefined) return undefined;
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(ImageSet))(
    raw,
  );
  if (!Option.isSome(decoded)) return undefined;
  const pins = decoded.value;
  return valid(pins) ? canonical(pins) : undefined;
};

export const sameImageSet = (
  left: readonly ContainerImagePin[] | undefined,
  right: readonly ContainerImagePin[] | undefined,
): boolean => {
  const a = left === undefined ? undefined : encodeImageSet(left);
  const b = right === undefined ? undefined : encodeImageSet(right);
  return a !== undefined && b !== undefined && a === b;
};

/** Protocol-2 metadata and the authoritative readback config must describe exactly the same set. */
export const validObservedImageSet = (machine: {
  config?: FlyMachineConfig;
}): boolean => {
  const metadata = machine.config?.metadata;
  if (metadata?.[keys.protocol] !== "2" || metadata[keys.image] !== undefined)
    return false;
  return sameImageSet(
    decodeImageSet(metadata[keys.containerImageSet]),
    pinsFromConfig(machine.config),
  );
};

/** Keep all named pins when changing service or idle policy on a candidate. */
export const applyImageSet = (
  config: FlyMachineConfig,
  pins: readonly ContainerImagePin[],
): FlyMachineConfig | undefined => {
  if (!valid(pins) || !config.containers) return undefined;
  const byName = new Map(pins.map((pin) => [pin.name, pin.image]));
  if (
    config.containers.length !== byName.size ||
    new Set(config.containers.map(({ name }) => name)).size !==
      config.containers.length ||
    config.containers.some(
      ({ name }) => name === undefined || !byName.has(name),
    )
  )
    return undefined;
  return {
    ...config,
    image: undefined,
    containers: config.containers.map((container) => ({
      ...container,
      image: byName.get(container.name!),
    })),
  };
};
