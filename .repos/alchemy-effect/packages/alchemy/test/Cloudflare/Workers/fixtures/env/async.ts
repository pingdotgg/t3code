import type { AsyncWorkerEnv } from "./stack.ts";

// Async (non-Effect) Worker handler that echoes its env bindings back as
// JSON so the test can assert that every supported `WorkerBindingResource`
// shape (string, number, boolean, null, array, object, Redacted<string>,
// Redacted<Json>, Config<string>, Config<number>) round-trips end-to-end.
export default {
  fetch: async (_request: Request, env: AsyncWorkerEnv) => {
    return new Response(
      JSON.stringify({
        STR: env.STR,
        NUM: env.NUM,
        BOOL: env.BOOL,
        NULL: env.NULL,
        OBJ: env.OBJ,
        ARR: env.ARR,
        SECRET_STR: env.SECRET_STR,
        // Redacted<Json> is JSON-stringified into secret_text on the way in,
        // so the async runtime sees a string here. Parse it back so the
        // test can compare the structured value.
        SECRET_JSON:
          typeof env.SECRET_JSON === "string"
            ? JSON.parse(env.SECRET_JSON)
            : env.SECRET_JSON,
        CONFIG_STR: env.CONFIG_STR,
        CONFIG_NUM: env.CONFIG_NUM,
        CONFIG_REDACTED: env.CONFIG_REDACTED,
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
};
