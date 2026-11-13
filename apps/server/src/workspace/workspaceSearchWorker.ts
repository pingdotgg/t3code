import * as NodeModule from "node:module";

import type { FileFinder as FileFinderType, InitOptions } from "@ff-labs/fff-node";

// fff-node's native library stays external; single-executables require disk packages instead of importing them.
const requireForFff = NodeModule.createRequire(import.meta.url);
const { FileFinder } = requireForFff("@ff-labs/fff-node") as typeof import("@ff-labs/fff-node");

export function runWorkspaceSearchWorker() {
  const finders = new Map<number, FileFinderType>();
  // The finders die with this process; the server closing the channel ends it.
  process.on("disconnect", () => process.exit(0));
  process.on(
    "message",
    async (message: {
      readonly id: number;
      readonly finderId: number;
      readonly method: "create" | "destroy" | Exclude<keyof FileFinderType, "isDestroyed">;
      readonly args: Array<unknown>;
    }) => {
      try {
        if (message.method === "create") {
          const created = FileFinder.create(message.args[0] as InitOptions);
          if (created.ok) finders.set(message.finderId, created.value);
          process.send!({ id: message.id, value: created.ok ? { ok: true } : created });
          return;
        }
        const finder = finders.get(message.finderId)!;
        if (message.method === "destroy") finders.delete(message.finderId);
        const method = finder[message.method] as (...args: Array<unknown>) => unknown;
        process.send!({ id: message.id, value: await method.apply(finder, message.args) });
      } catch (error) {
        process.send!({ id: message.id, error });
      }
    },
  );
}
