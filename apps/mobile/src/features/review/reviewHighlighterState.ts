import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
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

export class ReviewHighlighterManagerError extends Schema.TaggedErrorClass<ReviewHighlighterManagerError>()(
  "ReviewHighlighterManagerError",
  {
    operation: Schema.Literals(["prepare", "prepare-languages", "resolve-engine"]),
    languages: Schema.Array(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Review highlighter operation ${this.operation} failed for languages ${this.languages.join(", ")}.`;
  }
}

export interface ReviewHighlighterState {
  readonly engine: ReviewHighlighterEngine | null;
  readonly error: ReviewHighlighterManagerError | null;
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
      const languages = config.languages ?? REVIEW_INITIAL_LANGUAGES;
      let operation: ReviewHighlighterManagerError["operation"] = "prepare";
      let engine: ReviewHighlighterEngine;
      try {
        await config.loader.prepare();
        operation = "prepare-languages";
        await config.loader.prepareLanguages(languages);
        operation = "resolve-engine";
        engine = await config.loader.getEngine();
      } catch (cause) {
        const error = new ReviewHighlighterManagerError({
          operation,
          languages,
          cause,
        });
        logReviewHighlighterProviderDiagnostic("initialization failed", { error });
        setState({ engine: null, error, status: "error" });
        return;
      }

      const durationMs = Math.round(performance.now() - startedAt);
      logReviewHighlighterProviderDiagnostic("initialized", {
        durationMs,
        engine,
      });
      setState({ engine, error: null, status: "ready" });
    })().finally(() => {
      inFlight = null;
    });

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
