import type { WorkerProps } from "./Worker.ts";

// TODO: figure out why the later one from workerd breaks
const DEFAULT_COMPATIBILITY_DATE = "2026-03-17";

export const getCompatibility = (props: WorkerProps) => ({
  date: props.compatibility?.date ?? DEFAULT_COMPATIBILITY_DATE,
  flags: [
    ...(props.compatibility?.flags ?? []),
    ...(props.isExternal ? [] : ["nodejs_compat"]),
  ].filter((value, index, self) => self.indexOf(value) === index),
});
