import { PROJECT_ICON_COLORS } from "../../packages/provider-core/src/server/textGenerationUtils.ts";

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const gradeProjectIcon = (generated: { name: string; color: string }): boolean =>
  NAME_PATTERN.test(generated.name) &&
  generated.name.length <= 64 &&
  (PROJECT_ICON_COLORS as ReadonlyArray<string>).includes(generated.color);
