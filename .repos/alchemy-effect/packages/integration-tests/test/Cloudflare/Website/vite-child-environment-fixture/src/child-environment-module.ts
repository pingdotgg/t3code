// @ts-expect-error - no types
import { getEnvironmentName } from "virtual:environment-name";
import additionalModule from "./additional-module.txt";

export { additionalModule };

export function getMessage() {
  return `Hello from the ${getEnvironmentName()} environment`;
}
