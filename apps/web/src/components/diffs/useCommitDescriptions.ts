import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { reviewEnvironment } from "~/state/review";
import { useAtomCommand } from "~/state/use-atom-command";

const BATCH_SIZE = 10;

export function nextCommitDescriptionBatch(
  shas: ReadonlyArray<string>,
  wanted: number,
  requested: ReadonlySet<string>,
): string[] {
  return shas
    .slice(0, wanted)
    .filter((sha) => !requested.has(sha))
    .slice(0, BATCH_SIZE);
}

interface DescriptionState {
  readonly scope: string | null;
  readonly wanted: number;
  readonly descriptions: ReadonlyMap<string, string>;
  readonly pending: boolean;
  readonly failed: boolean;
}

const initialState = (scope: string | null): DescriptionState => ({
  scope,
  wanted: BATCH_SIZE,
  descriptions: new Map(),
  pending: false,
  failed: false,
});

export function useCommitDescriptions({
  environmentId,
  threadId,
  cwd,
  modelKey,
  shas,
  enabled,
  visible,
  open,
}: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  cwd: string | undefined;
  modelKey: string;
  shas: ReadonlyArray<string>;
  enabled: boolean;
  visible: boolean;
  open: boolean;
}) {
  const canGenerate = useAtomValue(
    reviewEnvironment.commitDescriptions.permissionAtom(environmentId),
  );
  const generate = useAtomCommand(reviewEnvironment.commitDescriptions, { reportFailure: false });
  const scope =
    enabled && canGenerate && environmentId && threadId && cwd
      ? JSON.stringify([environmentId, threadId, cwd, modelKey])
      : null;
  const [stored, setState] = useState(() => initialState(scope));
  const state = stored.scope === scope ? stored : initialState(scope);
  const requested = useRef({ scope, shas: new Set<string>() });
  const shasKey = shas.join(",");

  useEffect(() => {
    if (requested.current.scope !== scope) {
      requested.current = { scope, shas: new Set() };
      setState(initialState(scope));
    }
    if (
      !visible ||
      scope === null ||
      state.failed ||
      state.pending ||
      !environmentId ||
      !threadId ||
      !cwd
    )
      return;
    const request = requested.current;
    const batch = nextCommitDescriptionBatch(
      shasKey ? shasKey.split(",") : [],
      open ? state.wanted : BATCH_SIZE,
      request.shas,
    );
    if (batch.length === 0) return;
    for (const sha of batch) request.shas.add(sha);
    setState((stored) => ({
      ...(stored.scope === scope ? stored : initialState(scope)),
      pending: true,
    }));
    void generate({ environmentId, input: { cwd, threadId, shas: batch } }).then((result) => {
      if (requested.current !== request) return;
      if (result._tag !== "Success") {
        for (const sha of batch) request.shas.delete(sha);
      }
      setState((stored) => {
        const current = stored.scope === scope ? stored : initialState(scope);
        if (requested.current !== request) return stored;
        return result._tag === "Success"
          ? {
              ...current,
              pending: false,
              descriptions: new Map([
                ...current.descriptions,
                ...result.value.descriptions.map(
                  ({ sha, description }) => [sha, description] as const,
                ),
              ]),
            }
          : { ...current, pending: false, failed: true };
      });
    });
  }, [
    cwd,
    environmentId,
    generate,
    open,
    scope,
    shasKey,
    state.failed,
    state.pending,
    state.wanted,
    threadId,
    visible,
  ]);

  const retry = () => {
    setState((stored) =>
      stored.scope === scope && stored.failed ? { ...stored, failed: false } : stored,
    );
  };

  const observeLast = (element: HTMLElement | null) => {
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      setState((stored) => {
        const current = stored.scope === scope ? stored : initialState(scope);
        return { ...current, wanted: current.wanted + BATCH_SIZE };
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  };

  return { descriptions: state.descriptions, lastIndex: state.wanted - 1, observeLast, retry };
}
