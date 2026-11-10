import * as Context from "effect/Context";

/** The build arg and secret the fixture's image is built with. */
export interface BuildInputSet {
  readonly greeting: string;
  readonly token: string;
}

export const BuildInputs = Context.Reference<BuildInputSet>("BuildSecretsInputs", {
  defaultValue: () => ({ greeting: "hello", token: "alchemy-build-secret-value" }),
});
