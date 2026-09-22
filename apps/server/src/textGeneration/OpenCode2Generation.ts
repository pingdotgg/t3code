import type { OpenCodeClient, ModelRef } from "@opencode/client";
import * as Effect from "effect/Effect";
import * as Native from "../provider/OpenCode2Client.ts";

/** A workspace-scoped temporary session cannot inherit an agent's tool grants. */
export const generate = Effect.fn("OpenCode2Generation.generate")(function* (
  client: OpenCodeClient,
  input: {
    readonly cwd: string;
    readonly prompt: string;
    readonly model: ModelRef;
    readonly agent?: string;
    readonly files: ReadonlyArray<{ readonly uri: string }>;
  },
) {
  const session = yield* Effect.acquireRelease(
    Native.request("session.create", (signal) =>
      client.session.create(
        {
          location: { directory: input.cwd },
          model: input.model,
          ...(input.agent ? { agent: input.agent } : {}),
          permissions: [{ action: "*", resource: "*", effect: "deny" }],
        },
        { signal },
      ),
    ),
    (session) =>
      Native.request("session.remove", (signal) =>
        client.session.remove({ sessionID: session.id }, { signal }),
      ).pipe(Effect.ignore),
  );
  if (!input.files.length) {
    return (yield* Native.request("session.generate", (signal) =>
      client.session.generate({ sessionID: session.id, prompt: input.prompt }, { signal }),
    )).text;
  }
  yield* Native.request("session.prompt", (signal) =>
    client.session.prompt(
      { sessionID: session.id, text: input.prompt, files: [...input.files] },
      { signal },
    ),
  );
  yield* Native.request("session.wait", (signal) =>
    client.session.wait({ sessionID: session.id }, { signal }),
  );
  const state = yield* Native.request("session.get", (signal) =>
    client.session.get({ sessionID: session.id }, { signal }),
  );
  if (state.outcome !== "succeeded")
    return yield* new Native.OpenCode2RequestError({ operation: "generation.outcome" });
  const history = yield* Native.messages(client, session.id);
  return history
    .filter((message) => message.type === "assistant")
    .flatMap((message) =>
      message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )
    .join("\n");
}, Effect.scoped);
