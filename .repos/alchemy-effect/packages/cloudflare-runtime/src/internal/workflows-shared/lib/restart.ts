// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { InstanceEvent } from "../instance.ts";
import { MODIFIER_KEYS } from "../modifier.ts";
import type { RestartFromStep } from "../binding.ts";
import type { RawInstanceLog } from "../instance.ts";

const EVENT_MAP_PREFIX = "EVENT_MAP";
const RESTART_FROM_STEP_KEY = "RESTART_FROM_STEP";

const KV_STEP_SUFFIXES = [
  "-value",
  "-error",
  "-config",
  "-metadata",
  "-log-written",
  "-pending",
  "-value-stream-meta",
] as const;

export function resolveGroupKeysToWipe(
  sql: DurableObjectStorage["sql"],
  param: RestartFromStep,
): Set<string> | null {
  const stepTypeToEvent: Record<string, InstanceEvent> = {
    do: InstanceEvent.STEP_START,
    sleep: InstanceEvent.SLEEP_START,
    waitForEvent: InstanceEvent.WAIT_START,
  };
  const targetEvent = stepTypeToEvent[param.type ?? "do"];
  const targetCount = param.count ?? 1;

  const cursor = sql.exec<RawInstanceLog>(
    "SELECT event, target, groupKey FROM states WHERE event IN (?, ?, ?) ORDER BY id",
    InstanceEvent.STEP_START,
    InstanceEvent.SLEEP_START,
    InstanceEvent.WAIT_START,
  );

  let nameOccurrence = 0;
  let found = false;
  const groupKeys = new Set<string>();

  for (const row of cursor) {
    if (row.groupKey === null) {
      continue;
    }
    const groupKey = String(row.groupKey);

    if (found) {
      groupKeys.add(groupKey);
      continue;
    }

    if (row.target === null) {
      continue;
    }
    const rawStepName = String(row.target).replace(/-\d+$/, "");
    if (rawStepName !== param.name) {
      continue;
    }
    if (row.event !== targetEvent) {
      continue;
    }

    nameOccurrence++;
    if (nameOccurrence === targetCount) {
      found = true;
      groupKeys.add(groupKey);
    }
  }

  return found ? groupKeys : null;
}

function getMockedEventMapKeys(allKeys: Map<string, unknown>): Set<string> {
  const mockEventTypes = new Set<string>();
  for (const key of allKeys.keys()) {
    if (key.startsWith(MODIFIER_KEYS.MOCK_EVENT)) {
      mockEventTypes.add(key.slice(MODIFIER_KEYS.MOCK_EVENT.length));
    }
  }

  if (mockEventTypes.size === 0) {
    return new Set();
  }

  const preserved = new Set<string>();
  for (const key of allKeys.keys()) {
    if (key.startsWith(`${EVENT_MAP_PREFIX}\n`)) {
      const eventType = key.split("\n")[1];
      if (eventType !== undefined && mockEventTypes.has(eventType)) {
        preserved.add(key);
      }
    }
  }

  return preserved;
}

async function deleteGroupKeyBatch(
  storage: DurableObjectStorage,
  batch: Array<string>,
): Promise<void> {
  const kvKeys: Array<string> = [];
  for (const groupKey of batch) {
    for (const suffix of KV_STEP_SUFFIXES) {
      kvKeys.push(`${groupKey}${suffix}`);
    }
    storage.sql.exec("DELETE FROM states WHERE groupKey = ?", groupKey);
    storage.sql.exec(
      "DELETE FROM streaming_step_chunks WHERE attempt != 0 AND cache_key = ?",
      groupKey,
    );
  }
  await storage.delete(kvKeys);
}

export async function wipeRestartState(
  storage: DurableObjectStorage,
  engineStatusKey: string,
  pauseDatetimeKey: string,
  groupKeysToWipe: Set<string> | null,
): Promise<void> {
  if (groupKeysToWipe) {
    await deleteGroupKeyBatch(storage, Array.from(groupKeysToWipe));
    storage.sql.exec(
      "DELETE FROM states WHERE groupKey IS NULL AND event NOT IN (?, ?)",
      InstanceEvent.WORKFLOW_START,
      InstanceEvent.WORKFLOW_QUEUED,
    );
  } else {
    const cursor = storage.sql.exec<{ groupKey: string }>(
      "SELECT DISTINCT groupKey FROM states WHERE groupKey IS NOT NULL",
    );
    const allGroupKeys = [...cursor].map((r) => r.groupKey);
    if (allGroupKeys.length > 0) {
      await deleteGroupKeyBatch(storage, allGroupKeys);
    }
    storage.sql.exec("DELETE FROM states");
  }

  const keysToDelete: Array<string> = [engineStatusKey, pauseDatetimeKey];

  const allKeys = await storage.list();
  const preservedEventMapKeys = getMockedEventMapKeys(allKeys);
  for (const key of allKeys.keys()) {
    if (key.startsWith(`${EVENT_MAP_PREFIX}\n`) && !preservedEventMapKeys.has(key)) {
      keysToDelete.push(key);
    }
  }
  await storage.delete(keysToDelete);

  storage.sql.exec("DELETE FROM priority_queue");
}

export async function readAndClearRestartFromStep(
  storage: DurableObjectStorage,
): Promise<RestartFromStep | undefined> {
  const value = await storage.get<RestartFromStep>(RESTART_FROM_STEP_KEY);
  await storage.delete(RESTART_FROM_STEP_KEY);
  return value;
}

export async function storeRestartFromStep(
  storage: DurableObjectStorage,
  from: RestartFromStep,
): Promise<void> {
  await storage.put(RESTART_FROM_STEP_KEY, from);
}
