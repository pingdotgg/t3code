/**
 * Re-exports shared thread terminal state and reducer so draft and persisted
 * flows use the same shape and logic. See threadTerminalState.ts.
 */

import {
  createDefaultThreadTerminalState,
  normalizeThreadTerminalState,
  reduceThreadTerminalState,
  type ThreadTerminalAction,
  type ThreadTerminalState,
} from "./threadTerminalState";

export type DraftThreadTerminalState = ThreadTerminalState;
export type DraftThreadTerminalAction = ThreadTerminalAction;

export const createDefaultDraftThreadTerminalState = createDefaultThreadTerminalState;
export const reduceDraftThreadTerminalState = reduceThreadTerminalState;

export { normalizeThreadTerminalState };
