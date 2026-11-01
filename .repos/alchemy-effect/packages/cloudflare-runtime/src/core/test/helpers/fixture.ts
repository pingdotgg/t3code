import { fileURLToPath } from "node:url";

export const getFixture = (name: string) => {
  return fileURLToPath(import.meta.resolve(`../fixtures/${name}`));
};
