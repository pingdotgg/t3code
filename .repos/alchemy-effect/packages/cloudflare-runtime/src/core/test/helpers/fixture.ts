import { fileURLToPath } from "node:url";

export const getFixture = (name: string) =>
  fileURLToPath(import.meta.resolve(`../fixtures/${name}`));
