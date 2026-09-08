import * as Workerd from "workerd";

export const bin =
  typeof Workerd.default === "string"
    ? (Workerd.default as string)
    : (Workerd.default as { default: string }).default;
export const compatibilityDate = Workerd.compatibilityDate;
export const version = Workerd.version;
