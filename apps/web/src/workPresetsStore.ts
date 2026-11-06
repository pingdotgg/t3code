import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { ModelSelection as ModelSelectionSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";

const WORK_PRESETS_STORAGE_KEY = "t3code:work-presets:v1";
export const MAX_WORK_PRESETS_PER_ENVIRONMENT = 20;
const EMPTY_WORK_PRESETS: ReadonlyArray<WorkPreset> = [];
const isModelSelection = Schema.is(ModelSelectionSchema);

export interface WorkPreset {
  readonly id: string;
  readonly name: string;
  readonly environmentId: EnvironmentId;
  readonly modelSelection: ModelSelection;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface WorkPresetsState {
  readonly presetsByEnvironmentId: Readonly<Record<string, ReadonlyArray<WorkPreset>>>;
  readonly save: (environmentId: EnvironmentId, modelSelection: ModelSelection) => string;
  readonly remove: (environmentId: EnvironmentId, presetId: string) => void;
}

export function getWorkPresetsForEnvironment(
  state: Pick<WorkPresetsState, "presetsByEnvironmentId">,
  environmentId: EnvironmentId,
): ReadonlyArray<WorkPreset> {
  return state.presetsByEnvironmentId[environmentId] ?? EMPTY_WORK_PRESETS;
}

function selectionKey(selection: ModelSelection): string {
  return JSON.stringify(selection);
}

function optionSummary(selection: ModelSelection): string {
  const options = selection.options;
  if (!options || options.length === 0) return selection.model;
  const values = options.map((option) => `${option.id}: ${String(option.value)}`).join(", ");
  return `${selection.model} · ${values}`;
}

export function makeWorkPresetName(selection: ModelSelection, existingNames: ReadonlySet<string>) {
  const baseName = optionSummary(selection);
  if (!existingNames.has(baseName)) return baseName;
  for (let index = 2; index <= MAX_WORK_PRESETS_PER_ENVIRONMENT + 1; index += 1) {
    const candidate = `${baseName} (${index})`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `${baseName} (${Date.now()})`;
}

function isWorkPreset(value: unknown): value is WorkPreset {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkPreset>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.environmentId === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string" &&
    candidate.modelSelection !== undefined &&
    isModelSelection(candidate.modelSelection)
  );
}

export function normalizeWorkPresetsState(value: unknown): {
  presetsByEnvironmentId: Record<string, WorkPreset[]>;
} {
  if (!value || typeof value !== "object") return { presetsByEnvironmentId: {} };
  const raw = (value as { presetsByEnvironmentId?: unknown }).presetsByEnvironmentId;
  if (!raw || typeof raw !== "object") return { presetsByEnvironmentId: {} };

  const presetsByEnvironmentId: Record<string, WorkPreset[]> = {};
  for (const [environmentId, entries] of Object.entries(raw)) {
    if (!Array.isArray(entries)) continue;
    const seen = new Set<string>();
    const presets = entries.filter(isWorkPreset).filter((preset) => {
      if (preset.environmentId !== environmentId || seen.has(preset.id)) return false;
      seen.add(preset.id);
      return true;
    });
    if (presets.length > 0) {
      presetsByEnvironmentId[environmentId] = presets.slice(0, MAX_WORK_PRESETS_PER_ENVIRONMENT);
    }
  }
  return { presetsByEnvironmentId };
}

export const useWorkPresetsStore = create<WorkPresetsState>()(
  persist(
    (set) => ({
      presetsByEnvironmentId: {},
      save: (environmentId, modelSelection) => {
        const id = randomUUID();
        const now = new Date().toISOString();
        let savedId = id;
        set((state) => {
          const current = [...(state.presetsByEnvironmentId[environmentId] ?? [])];
          const key = selectionKey(modelSelection);
          const existing = current.find((preset) => selectionKey(preset.modelSelection) === key);
          if (existing) {
            savedId = existing.id;
            return state;
          }
          const name = makeWorkPresetName(
            modelSelection,
            new Set(current.map((preset) => preset.name)),
          );
          const nextPreset: WorkPreset = {
            id,
            name,
            environmentId,
            modelSelection,
            createdAt: now,
            updatedAt: now,
          };
          return {
            presetsByEnvironmentId: {
              ...state.presetsByEnvironmentId,
              [environmentId]: [nextPreset, ...current].slice(0, MAX_WORK_PRESETS_PER_ENVIRONMENT),
            },
          };
        });
        return savedId;
      },
      remove: (environmentId, presetId) =>
        set((state) => {
          const current = state.presetsByEnvironmentId[environmentId] ?? [];
          const next = current.filter((preset) => preset.id !== presetId);
          if (next.length === current.length) return state;
          const presetsByEnvironmentId = { ...state.presetsByEnvironmentId };
          if (next.length === 0) delete presetsByEnvironmentId[environmentId];
          else presetsByEnvironmentId[environmentId] = next;
          return { presetsByEnvironmentId };
        }),
    }),
    {
      name: WORK_PRESETS_STORAGE_KEY,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      migrate: (persisted) => normalizeWorkPresetsState(persisted),
      merge: (persisted, current) => ({
        ...current,
        ...normalizeWorkPresetsState(persisted),
      }),
      partialize: ({ presetsByEnvironmentId }) => ({ presetsByEnvironmentId }),
    },
  ),
);
