import { expect, it } from "vite-plus/test";

import { loadFrontLlama } from "./llama.ts";

// Replies with the last message; "hang" generates until the worker aborts it.
const fixture = `data:text/javascript,${encodeURIComponent(`
  export const load = async ({ path, gpu, schema }) => ({
    gpu: gpu === false ? "cpu" : "fake",
    decide: (messages, signal) => {
      const last = messages.at(-1).content;
      if (last !== "hang") return Promise.resolve(JSON.stringify({ path, last, keys: schema.required }));
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    },
  });
`)}`;

it("decides from an isolated process and keeps working after an interrupted decision", async () => {
  const llama = await loadFrontLlama("/models/front.gguf", new AbortController().signal, {
    moduleUrl: fixture,
  });
  try {
    expect(llama.gpu).toBe("fake");
    const interrupted = new AbortController();
    const hung = llama.decide([{ role: "user", content: "hang" }], interrupted.signal);
    const next = llama.decide([{ role: "user", content: "hi" }], new AbortController().signal);
    interrupted.abort(new Error("barge-in"));
    await expect(hung).rejects.toThrow("barge-in");
    // The queued decision only runs once the worker has dropped the interrupted one.
    expect(JSON.parse(await next)).toEqual({
      path: "/models/front.gguf",
      last: "hi",
      keys: ["action", "speech", "task"],
    });
  } finally {
    await llama.dispose();
  }
});

it("abort kills the process and fails the decision in flight", async () => {
  const controller = new AbortController();
  const llama = await loadFrontLlama("unused", controller.signal, { moduleUrl: fixture });
  const hung = llama.decide([{ role: "user", content: "hang" }], new AbortController().signal);
  controller.abort();
  await expect(hung).rejects.toThrow("Front model process stopped.");
  await expect(
    llama.decide([{ role: "user", content: "later" }], new AbortController().signal),
  ).rejects.toThrow("Front model process stopped.");
  await llama.dispose();
});
