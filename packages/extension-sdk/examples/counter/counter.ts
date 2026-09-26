import type { Extension, ViewSession } from "@t3tools/extension-sdk/host";
export interface CounterRenderer {
  read(): number;
  increment(): Promise<void>;
}
export const counter: Extension<CounterRenderer> = {
  manifest: {
    id: "example.counter",
    version: "1.0.0",
    apiVersion: 1,
    surfaces: [
      {
        id: "example.counter/view",
        title: "Counter",
        placements: ["side-panel", "bottom-dock"],
        clients: ["web"],
        scope: "thread",
        capabilities: ["host.counter/read"],
        stateVersion: 1,
      },
    ],
  },
  surfaces: [
    {
      id: "example.counter/view",
      validateRestore: (state) =>
        state === null ||
        (typeof state === "object" && "count" in state && typeof state.count === "number"),
      createView(session: ViewSession) {
        const state = session.restoreState;
        let count =
          state && typeof state === "object" && "count" in state && typeof state.count === "number"
            ? state.count
            : 0;
        let sequence = 0;
        session.publish(sequence++, { count });
        return {
          renderer: {
            read: () => count,
            async increment() {
              const result = await session.invoke("host.counter/read", { count });
              if (
                !result ||
                typeof result !== "object" ||
                !("count" in result) ||
                typeof result.count !== "number"
              )
                throw new Error("Invalid counter response");
              count = result.count;
              session.save({ count });
              session.publish(sequence++, { count });
            },
          },
        };
      },
    },
  ],
};
