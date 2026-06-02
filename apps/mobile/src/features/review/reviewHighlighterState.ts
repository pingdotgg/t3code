import { useAtomValue } from "@effect/atom-react";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  getActiveReviewHighlighterEngine,
  prepareReviewHighlighter,
  prepareReviewHighlighterLanguages,
  type ReviewHighlighterEngine,
} from "./shikiReviewHighlighter";

export type ReviewHighlighterStatus = "idle" | "initializing" | "ready" | "error";

export interface ReviewHighlighterState {
  readonly engine: ReviewHighlighterEngine | null;
  readonly error: string | null;
  readonly status: ReviewHighlighterStatus;
}

export interface ReviewHighlighterLoader {
  readonly prepare: () => Promise<void>;
  readonly prepareLanguages: (languages: ReadonlyArray<string>) => Promise<void>;
  readonly getEngine: () => Promise<ReviewHighlighterEngine>;
}

const REVIEW_INITIAL_LANGUAGES = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "yaml",
  "bash",
] as const;

export const IDLE_REVIEW_HIGHLIGHTER_STATE = Object.freeze<ReviewHighlighterState>({
  engine: null,
  error: null,
  status: "idle",
});

const INITIALIZING_REVIEW_HIGHLIGHTER_STATE = Object.freeze<ReviewHighlighterState>({
  engine: null,
  error: null,
  status: "initializing",
});

export const reviewHighlighterStateAtom = Atom.make(IDLE_REVIEW_HIGHLIGHTER_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:review-highlighter"),
);

function isReviewHighlighterProviderDebugLoggingEnabled(): boolean {
  return typeof __DEV__ !== "undefined" ? __DEV__ : false;
}

function logReviewHighlighterProviderDiagnostic(
  message: string,
  details?: Record<string, unknown>,
): void {
  if (!isReviewHighlighterProviderDebugLoggingEnabled()) {
    return;
  }

  if (details) {
    console.log(`[review-highlighter-provider] ${message}`, details);
    return;
  }

  console.log(`[review-highlighter-provider] ${message}`);
}

export function createReviewHighlighterManager(config: {
  readonly getRegistry: () => AtomRegistry.AtomRegistry;
  readonly loader: ReviewHighlighterLoader;
  readonly languages?: ReadonlyArray<string>;
}) {
  let started = false;
  let inFlight: Promise<void> | null = null;

  function getSnapshot(): ReviewHighlighterState {
    return config.getRegistry().get(reviewHighlighterStateAtom);
  }

  function setState(state: ReviewHighlighterState): void {
    config.getRegistry().set(reviewHighlighterStateAtom, state);
  }

  function initialize(): Promise<void> {
    if (inFlight) {
      return inFlight;
    }

    if (started && getSnapshot().status === "ready") {
      return Promise.resolve();
    }

    started = true;
    setState(INITIALIZING_REVIEW_HIGHLIGHTER_STATE);

    inFlight = (async () => {
      const startedAt = performance.now();
      try {
        await config.loader.prepare();
        await config.loader.prepareLanguages(config.languages ?? REVIEW_INITIAL_LANGUAGES);
        const engine = await config.loader.getEngine();
        const durationMs = Math.round(performance.now() - startedAt);
        logReviewHighlighterProviderDiagnostic("initialized", {
          durationMs,
          engine,
        });
        setState({ engine, error: null, status: "ready" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logReviewHighlighterProviderDiagnostic("initialization failed", { error: message });
        setState({ engine: null, error: message, status: "error" });
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  }

  function reset(): void {
    started = false;
    inFlight = null;
    setState(IDLE_REVIEW_HIGHLIGHTER_STATE);
  }

  return {
    getSnapshot,
    initialize,
    reset,
  };
}

const reviewHighlighterManager = createReviewHighlighterManager({
  getRegistry: () => appAtomRegistry,
  loader: {
    prepare: prepareReviewHighlighter,
    prepareLanguages: prepareReviewHighlighterLanguages,
    getEngine: getActiveReviewHighlighterEngine,
  },
});

export function useReviewHighlighterState(): ReviewHighlighterState {
  useEffect(() => {
    void reviewHighlighterManager.initialize();
  }, []);

  return useAtomValue(reviewHighlighterStateAtom);
}
