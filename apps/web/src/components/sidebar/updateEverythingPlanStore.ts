import * as Schema from "effect/Schema";
import { UpdateExecutionPlan, type UpdatePlanStore } from "./updateEverythingPlan";

const decode = Schema.decodeUnknownSync(UpdateExecutionPlan);

export async function openUpdatePlanStore(name = "t3code-update-plan-v1") {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore("plan"));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () =>
      reject(new Error("Update storage is blocked by another window")),
    );
  });
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(name);
  const publish = channel?.postMessage.bind(channel);
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  channel?.addEventListener("message", notify);
  const transact = (
    mode: IDBTransactionMode,
    update?: (plan: UpdateExecutionPlan | null) => UpdateExecutionPlan | null,
    discard = false,
  ) =>
    new Promise<UpdateExecutionPlan | null>((resolve, reject) => {
      const transaction = database.transaction("plan", mode);
      const store = transaction.objectStore("plan");
      const request = store.get("active");
      let value: UpdateExecutionPlan | null = null;
      let changed = false;
      let failure: unknown;
      request.onsuccess = () => {
        try {
          const current = discard || request.result === undefined ? null : decode(request.result);
          value = update ? update(current) : current;
          if (discard || (update && value !== current)) {
            if (value === null) store.delete("active");
            else store.put(decode(value), "active");
            changed = true;
          }
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.addEventListener("complete", () => {
        if (changed) {
          notify();
          publish?.(value?.id ?? null);
        }
        resolve(value);
      });
      transaction.addEventListener("abort", () =>
        reject(failure ?? transaction.error ?? new Error("Could not save update plan")),
      );
      transaction.addEventListener("error", () => {
        failure ??= transaction.error;
      });
    });
  const change: UpdatePlanStore["change"] = (update) => transact("readwrite", update);
  return {
    read: () => transact("readonly"),
    change,
    discard: () => transact("readwrite", undefined, true),
    create: async (plan: UpdateExecutionPlan) => {
      let created = false;
      await change((current) => {
        if (current) return current;
        created = true;
        return plan;
      });
      return created;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    [Symbol.asyncDispose]: async () => {
      database.close();
      channel?.close();
      listeners.clear();
    },
  };
}

let store: ReturnType<typeof openUpdatePlanStore> | null = null;
export const updatePlanStore = () =>
  (store ??= openUpdatePlanStore().catch((error) => {
    store = null;
    throw error;
  }));
