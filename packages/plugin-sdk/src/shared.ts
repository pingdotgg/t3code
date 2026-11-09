export type JsonValue = null | boolean | number | string | ReadonlyArray<JsonValue> | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * A plugin's server methods and channels, as in `{ methods: { add: { input: { text: string };
 * output: string } }; channels: {} }`. Pass it to `definePlugin` and `defineWebPlugin` so both halves
 * check their calls. Use `input: undefined` for no input, and `type`, not `interface`, for values.
 */
export interface PluginRpcMap {
  readonly methods: {
    readonly [method: string]: {
      readonly input: JsonValue | undefined;
      readonly output: JsonValue;
    };
  };
  readonly channels: { readonly [channel: string]: JsonValue };
}
