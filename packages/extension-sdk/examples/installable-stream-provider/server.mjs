import * as NodeCrypto from "node:crypto";

const states = new Map();
function stateFor(context) {
  const key = JSON.stringify([
    context.resource.environmentId,
    context.resource.projectId,
    context.workspaceRevision,
  ]);
  let state = states.get(key);
  if (!state) {
    if (states.size >= 64) throw new Error("Counter project limit reached");
    state = { count: 0, epoch: NodeCrypto.randomUUID(), listeners: new Set() };
    states.set(key, state);
  }
  return state;
}
const snapshot = (state) => ({ count: state.count, epoch: state.epoch });
export default {
  tools: [],
  apis: [
    {
      id: "example.stream-provider/state",
      methods: [
        {
          name: "increment",
          invoke(_input, session) {
            if (session.signal.aborted) throw new Error("Counter operation cancelled");
            const state = stateFor(session.context);
            if (state.count >= Number.MAX_SAFE_INTEGER) throw new Error("Counter exhausted");
            state.count++;
            for (const changed of state.listeners) changed();
            return snapshot(state);
          },
        },
      ],
      streams: [
        {
          name: "changes",
          subscribe(_input, session) {
            const state = stateFor(session.context);
            return {
              [Symbol.asyncIterator]() {
                let dirty = true;
                let first = true;
                let closed = false;
                let waiting;
                const event = () => {
                  const type =
                    first &&
                    session.resumeCursor &&
                    session.resumeCursor !== state.epoch + ":" + state.count
                      ? "reset"
                      : "snapshot";
                  first = false;
                  return { type, value: snapshot(state), cursor: state.epoch + ":" + state.count };
                };
                const changed = () => {
                  dirty = true;
                  if (waiting) {
                    const done = waiting;
                    waiting = undefined;
                    dirty = false;
                    done({ done: false, value: event() });
                  }
                };
                const close = () => {
                  if (closed) return;
                  closed = true;
                  state.listeners.delete(changed);
                  session.signal.removeEventListener("abort", close);
                  waiting?.({ done: true, value: undefined });
                  waiting = undefined;
                };
                if (session.signal.aborted) close();
                else {
                  state.listeners.add(changed);
                  session.signal.addEventListener("abort", close, { once: true });
                }
                return {
                  async next() {
                    if (closed) return { done: true, value: undefined };
                    if (waiting) throw new Error("Concurrent counter pull");
                    if (dirty) {
                      dirty = false;
                      return { done: false, value: event() };
                    }
                    return new Promise((resolve) => {
                      waiting = resolve;
                    });
                  },
                  async return() {
                    close();
                    return { done: true, value: undefined };
                  },
                };
              },
            };
          },
        },
      ],
    },
  ],
};
