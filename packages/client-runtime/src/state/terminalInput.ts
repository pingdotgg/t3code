import type { EnvironmentId, TerminalWriteInput } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";

import type { AtomCommand, AtomCommandResult } from "./runtime.ts";

export const TERMINAL_INPUT_MAX_BATCH_CHARS = 65_536;
export const TERMINAL_INPUT_MAX_BUFFERED_CHARS = 512 * 1024;

export interface TerminalInputTarget {
  readonly environmentId: EnvironmentId;
  readonly input: TerminalWriteInput;
}

export class TerminalInputBackpressureError extends Error {
  readonly _tag = "TerminalInputBackpressureError";
  readonly maxBufferedChars: number;

  constructor(maxBufferedChars: number) {
    super(
      `Terminal input is arriving faster than it can be sent (${maxBufferedChars} characters buffered).`,
    );
    this.maxBufferedChars = maxBufferedChars;
  }
}

interface PendingInput<A, E> {
  readonly target: TerminalInputTarget;
  readonly resolve: (result: AtomCommandResult<A, E | TerminalInputBackpressureError>) => void;
}

interface InputLane<A, E> {
  pending: Array<PendingInput<A, E>>;
  bufferedChars: number;
  flushScheduled: boolean;
  tail: Promise<void>;
}

function terminalInputKey(target: TerminalInputTarget): string {
  return JSON.stringify([target.environmentId, target.input.threadId, target.input.terminalId]);
}

/**
 * Keeps one ordered writer lane per terminal. Input produced in the same task
 * is coalesced into the fewest legal RPC payloads, while discard-mode sends
 * keep the lane moving without waiting for a round trip.
 */
export function createTerminalInputCommand<A, E>(
  send: AtomCommand<TerminalInputTarget, A, E>,
  options: {
    readonly maxBatchChars?: number;
    readonly maxBufferedChars?: number;
  } = {},
): AtomCommand<TerminalInputTarget, A, E | TerminalInputBackpressureError> {
  const maxBatchChars = options.maxBatchChars ?? TERMINAL_INPUT_MAX_BATCH_CHARS;
  const maxBufferedChars = options.maxBufferedChars ?? TERMINAL_INPUT_MAX_BUFFERED_CHARS;
  const registryLanes = new WeakMap<AtomRegistry.AtomRegistry, Map<string, InputLane<A, E>>>();

  const lanesFor = (registry: AtomRegistry.AtomRegistry) => {
    const existing = registryLanes.get(registry);
    if (existing !== undefined) return existing;
    const lanes = new Map<string, InputLane<A, E>>();
    registryLanes.set(registry, lanes);
    return lanes;
  };

  const flush = (
    registry: AtomRegistry.AtomRegistry,
    lanes: Map<string, InputLane<A, E>>,
    key: string,
    lane: InputLane<A, E>,
  ) => {
    lane.flushScheduled = false;
    const pending = lane.pending;
    lane.pending = [];

    let group: Array<PendingInput<A, E>> = [];
    let groupChars = 0;
    const sendGroup = () => {
      if (group.length === 0) return;
      const currentGroup = group;
      const data = currentGroup.map((entry) => entry.target.input.data).join("");
      const target = currentGroup[0]!.target;
      group = [];
      groupChars = 0;
      lane.tail = lane.tail.then(async () => {
        const result = await send.run(registry, {
          environmentId: target.environmentId,
          input: { ...target.input, data },
        });
        lane.bufferedChars -= data.length;
        for (const entry of currentGroup) entry.resolve(result);
        if (lane.bufferedChars === 0 && lane.pending.length === 0 && lanes.get(key) === lane) {
          lanes.delete(key);
        }
      });
    };

    const sendOversizedEntry = (entry: PendingInput<A, E>) => {
      const { target } = entry;
      lane.tail = lane.tail.then(async () => {
        let result: AtomCommandResult<A, E> | undefined;
        for (let offset = 0; offset < target.input.data.length; ) {
          let end = Math.min(offset + maxBatchChars, target.input.data.length);
          const splitsSurrogatePair =
            end - offset > 1 &&
            end < target.input.data.length &&
            target.input.data.charCodeAt(end - 1) >= 0xd800 &&
            target.input.data.charCodeAt(end - 1) <= 0xdbff &&
            target.input.data.charCodeAt(end) >= 0xdc00 &&
            target.input.data.charCodeAt(end) <= 0xdfff;
          if (splitsSurrogatePair) end -= 1;
          const data = target.input.data.slice(offset, end);
          const chunkResult = await send.run(registry, {
            environmentId: target.environmentId,
            input: { ...target.input, data },
          });
          result = result?._tag === "Failure" ? result : chunkResult;
          lane.bufferedChars -= data.length;
          offset = end;
        }
        entry.resolve(result!);
        if (lane.bufferedChars === 0 && lane.pending.length === 0 && lanes.get(key) === lane) {
          lanes.delete(key);
        }
      });
    };

    for (const entry of pending) {
      const chars = entry.target.input.data.length;
      if (chars > maxBatchChars) {
        sendGroup();
        sendOversizedEntry(entry);
        continue;
      }
      if (groupChars > 0 && groupChars + chars > maxBatchChars) sendGroup();
      group.push(entry);
      groupChars += chars;
      if (groupChars >= maxBatchChars) sendGroup();
    }
    sendGroup();
  };

  return {
    label: "environment-data:terminal:input",
    run: (registry, target) => {
      const lanes = lanesFor(registry);
      const key = terminalInputKey(target);
      let lane = lanes.get(key);
      if (lane === undefined) {
        lane = { pending: [], bufferedChars: 0, flushScheduled: false, tail: Promise.resolve() };
        lanes.set(key, lane);
      }

      if (lane.bufferedChars + target.input.data.length > maxBufferedChars) {
        return Promise.resolve(
          AsyncResult.failure(Cause.fail(new TerminalInputBackpressureError(maxBufferedChars))),
        );
      }

      lane.bufferedChars += target.input.data.length;
      const result = new Promise<AtomCommandResult<A, E | TerminalInputBackpressureError>>(
        (resolve) => lane!.pending.push({ target, resolve }),
      );
      if (!lane.flushScheduled) {
        lane.flushScheduled = true;
        queueMicrotask(() => flush(registry, lanes, key, lane!));
      }
      return result;
    },
  };
}
