import type {
  ClaudeInstructionValue,
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useMemo, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  CHANGE_FAILED,
  claudeChange,
  describeAgentsResult,
  describeChange,
  failureText,
  ingestInstructions,
  instructionErrorReason,
  instructionAttentionCount,
  instructionsToCheckWithGit,
  withInstructionGitNote,
  type ClaudeRow,
  type InstructionData,
  type InstructionPlan,
} from "./InstructionsSettings.logic";
import { installedAgents, type SkillsContext } from "./SkillsSettings.logic";

const INSTRUCTIONS_LOAD_ERROR = "Couldn't read this environment's instruction files.";

/**
 * The Instructions section's data and the changes it can make. Like the skills, the page shows
 * what is on disk: every change is followed by reading the files again.
 */
export function useInstructions({
  environmentId,
  connected,
  cwd,
  providers,
  onNotice,
}: {
  environmentId: EnvironmentId;
  connected: boolean;
  /** The project picked above the page, or null when none is. */
  cwd: string | null;
  providers: readonly ServerProvider[];
  /** A change finished, with a line on what it did. */
  onNotice: (text: string) => void;
}) {
  const listInstructions = useAtomCommand(serverEnvironment.listInstructions, {
    reportFailure: false,
  });
  const enableInstruction = useAtomCommand(serverEnvironment.enableInstruction, {
    reportFailure: false,
  });
  const disableInstruction = useAtomCommand(serverEnvironment.disableInstruction, {
    reportFailure: false,
  });
  const setClaudeInstructionFiles = useAtomCommand(serverEnvironment.setClaudeInstructionFiles, {
    reportFailure: false,
  });
  const shareInstruction = useAtomCommand(serverEnvironment.shareInstruction, {
    reportFailure: false,
  });
  const adoptInstruction = useAtomCommand(serverEnvironment.adoptInstruction, {
    reportFailure: false,
  });
  const deleteInstruction = useAtomCommand(serverEnvironment.deleteInstruction, {
    reportFailure: false,
  });
  const instructionsTracked = useAtomCommand(serverEnvironment.instructionsTracked, {
    reportFailure: false,
  });

  // Reading needs no grant; each change needs its command's.
  const canWrite = useAtomValue(serverEnvironment.writeInstruction.permissionAtom(environmentId));
  const canEnable = useAtomValue(serverEnvironment.enableInstruction.permissionAtom(environmentId));
  const canDisable = useAtomValue(
    serverEnvironment.disableInstruction.permissionAtom(environmentId),
  );
  const canSetClaude = useAtomValue(
    serverEnvironment.setClaudeInstructionFiles.permissionAtom(environmentId),
  );
  const canShare = useAtomValue(serverEnvironment.shareInstruction.permissionAtom(environmentId));
  const canAdopt = useAtomValue(serverEnvironment.adoptInstruction.permissionAtom(environmentId));
  const canDelete = useAtomValue(serverEnvironment.deleteInstruction.permissionAtom(environmentId));
  const canChange =
    canWrite && canEnable && canDisable && canSetClaude && canShare && canAdopt && canDelete;

  const [data, setData] = useState<InstructionData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** A change is being made and the files read again; nothing else can start meanwhile. */
  const [busy, setBusy] = useState(false);
  /** A change that is waiting for the person to confirm it. */
  const [confirming, setConfirming] = useState<InstructionPlan | null>(null);

  const load = useCallback(async () => {
    const result = await listInstructions({
      environmentId,
      input: cwd ? { cwd } : {},
    });
    return result._tag === "Success" ? ingestInstructions(result.value) : null;
  }, [listInstructions, environmentId, cwd]);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void load()
      .then((loaded) => {
        if (cancelled) return;
        setData(loaded);
        setLoadError(loaded ? null : INSTRUCTIONS_LOAD_ERROR);
      })
      .catch(() => {
        if (!cancelled) setLoadError(INSTRUCTIONS_LOAD_ERROR);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, load]);

  /** Reads the files again and shows them; says so when they can't be read. */
  const reload = useCallback(async () => {
    try {
      const loaded = await load();
      if (loaded) setData(loaded);
      setLoadError(loaded ? null : INSTRUCTIONS_LOAD_ERROR);
    } catch {
      setLoadError(INSTRUCTIONS_LOAD_ERROR);
    }
  }, [load]);

  /** Reads the files again without a word, such as after an edit was saved. */
  const refreshQuietly = useCallback(() => {
    void load()
      .then((loaded) => {
        if (loaded) setData(loaded);
      })
      .catch(() => undefined);
  }, [load]);

  const installed = useMemo(
    () => (data ? installedAgents(providers, data.known) : []),
    [data, providers],
  );
  const ctx = useMemo<SkillsContext>(() => ({ installed }), [installed]);
  const attentionCount = useMemo(
    () => (data ? instructionAttentionCount(data, ctx) : 0),
    [data, ctx],
  );

  /** Asks the server for the change and says what came of it, and whether it went through. */
  const run = async (plan: InstructionPlan): Promise<{ text: string; done: boolean }> => {
    const { change } = plan;
    const base = { environmentId } as const;
    const scoped = cwd ? { cwd } : {};
    const failed = (result: Parameters<typeof squashAtomCommandFailure>[0]) => ({
      text: failureText(instructionErrorReason(squashAtomCommandFailure(result))),
      done: false,
    });
    const setClaude = async (
      instances: readonly ProviderInstanceId[],
      value: ClaudeInstructionValue | null,
    ) => {
      for (const instanceId of instances) {
        const result = await setClaudeInstructionFiles({ ...base, input: { instanceId, value } });
        if (result._tag !== "Success") return result;
      }
      return null;
    };
    switch (change.kind) {
      case "setClaude": {
        const result = await setClaude(change.instances, change.value);
        return result ? failed(result) : { text: describeChange(change, ctx), done: true };
      }
      case "enable":
      case "disable": {
        const input = { ...scoped, id: change.id, agents: change.agents };
        const result =
          change.kind === "enable"
            ? await enableInstruction({ ...base, input })
            : await disableInstruction({ ...base, input });
        return result._tag === "Success"
          ? { text: describeAgentsResult(change.kind, result.value.results, ctx), done: true }
          : failed(result);
      }
      case "adopt": {
        for (const id of change.ids) {
          const result = await adoptInstruction({ ...base, input: { id } });
          if (result._tag !== "Success") return failed(result);
        }
        return { text: describeChange(change, ctx), done: true };
      }
      case "share": {
        // Sharing renames or merges a file in a project, so it needs the project picked above the page.
        if (!cwd) return { text: CHANGE_FAILED, done: false };
        const shared = await shareInstruction({
          ...base,
          input: { cwd, id: change.id, merge: change.merge },
        });
        if (shared._tag !== "Success") return failed(shared);
        // The file is changed; Claude's setting follows, and a failure there is said after it. The
        // page still leaves the file, which is gone.
        const claude = await setClaude(change.claude, "claude-md-and-agents-md");
        if (claude) {
          const lead = describeChange({ ...change, claude: [] }, ctx);
          return { text: `${lead} ${failed(claude).text}`, done: true };
        }
        return { text: describeChange(change, ctx), done: true };
      }
      case "delete": {
        const result = await deleteInstruction({ ...base, input: { ...scoped, id: change.id } });
        return result._tag === "Success"
          ? { text: describeChange(change, ctx), done: true }
          : failed(result);
      }
    }
  };

  /** Makes the change and reads the files again; says whether it went through. */
  const apply = async (plan: InstructionPlan) => {
    setConfirming(null);
    setBusy(true);
    let done = false;
    try {
      const result = await run(plan);
      done = result.done;
      onNotice(result.text);
    } catch {
      onNotice(CHANGE_FAILED);
    }
    await reload();
    setBusy(false);
    return done;
  };

  /**
   * A plan that needs confirming waits for the dialog; any other goes ahead. For a move, merge or
   * delete the dialog opens at once and git is asked meanwhile: the "undo with git" line appears
   * when the answer is in, and never when the check fails.
   */
  const runPlan = (plan: InstructionPlan) => {
    if (!plan.confirmation) {
      void apply(plan);
      return;
    }
    setConfirming(plan);
    const ids = cwd ? instructionsToCheckWithGit(plan) : null;
    if (!cwd || !ids) return;
    void (async () => {
      try {
        const result = await instructionsTracked({ environmentId, input: { cwd, ids } });
        if (result._tag !== "Success") return;
        const tracked = result.value.tracked;
        setConfirming((current) =>
          current === plan ? withInstructionGitNote(plan, tracked) : current,
        );
      } catch {
        // No answer, no promise: the dialog stays as it was.
      }
    })();
  };

  /** Claude's choice is a setting, not a file, so it goes ahead without asking. */
  const chooseClaude = (row: ClaudeRow, value: ClaudeInstructionValue) => {
    const change = claudeChange(row.choice, value);
    if (change) void apply({ change });
  };

  return {
    data,
    loadError,
    ctx,
    attentionCount,
    busy,
    canChange,
    confirming,
    cancelConfirm: () => setConfirming(null),
    reload,
    refreshQuietly,
    apply,
    runPlan,
    chooseClaude,
  };
}
