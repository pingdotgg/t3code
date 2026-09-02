import type { EnvironmentId, ProviderInteractionMode, ServerProvider } from "@t3tools/contracts";
import {
  detectComposerTrigger,
  replaceTextRange,
  serializeComposerFileLink,
} from "@t3tools/shared/composerTrigger";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";
import {
  dedupeProviderSkillsByName,
  getProviderSkillsForSlashMenu,
  isProviderSkillUserInvocable,
} from "@t3tools/client-runtime/providerSkills";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { useComposerPathSearch } from "../../state/queries";
import type { ComposerCommandItem } from "./ComposerCommandPopover";
import { matchesSlashSkillQuery } from "./composerSlashSkillSearch";

export function composerSelectionAtEnd(draftMessage: string): ComposerEditorSelection {
  return { start: draftMessage.length, end: draftMessage.length };
}

/** Shared autocomplete for thread composers and unsent new-task drafts. */
export function useComposerCommandMenu({
  draftMessage,
  ownerKey,
  environmentId,
  projectCwd,
  selectedProviderStatus,
  hasThread,
  enabled = true,
  onChangeDraftMessage,
  onUpdateInteractionMode,
}: {
  readonly draftMessage: string;
  readonly ownerKey: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly projectCwd: string | null;
  readonly selectedProviderStatus: ServerProvider | null;
  readonly hasThread: boolean;
  readonly enabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onUpdateInteractionMode?: (mode: ProviderInteractionMode) => void;
}) {
  const [selection, setSelection] = useState(() => composerSelectionAtEnd(draftMessage));
  const previousOwnerKeyRef = useRef(ownerKey);
  const onSelectionChange = useCallback((nextSelection: ComposerEditorSelection) => {
    setSelection(nextSelection);
  }, []);
  useEffect(() => {
    const end = draftMessage.length;
    setSelection((current) => {
      const start = Math.min(current.start, end);
      const selectionEnd = Math.min(current.end, end);
      if (start === current.start && selectionEnd === current.end) {
        return current;
      }
      return { start, end: selectionEnd };
    });
  }, [draftMessage.length]);
  useEffect(() => {
    if (previousOwnerKeyRef.current === ownerKey) return;
    previousOwnerKeyRef.current = ownerKey;
    setSelection(composerSelectionAtEnd(draftMessage));
  }, [draftMessage, ownerKey]);

  const trigger = useMemo(() => {
    if (!enabled || selection.start !== selection.end) {
      return null;
    }
    return detectComposerTrigger(draftMessage, selection.end);
  }, [draftMessage, enabled, selection]);
  const pathSearch = useComposerPathSearch({
    environmentId,
    cwd: trigger?.kind === "path" ? projectCwd : null,
    query: trigger?.kind === "path" ? trigger.query : null,
  });

  const items = useMemo<ComposerCommandItem[]>(() => {
    if (!trigger) return [];

    if (trigger.kind === "slash-command") {
      const q = trigger.query.toLowerCase();
      const allBuiltIn = [
        {
          id: "cmd:model",
          type: "slash-command" as const,
          command: "model",
          label: "/model",
          description: "Switch model",
        },
        {
          id: "cmd:plan",
          type: "slash-command" as const,
          command: "plan",
          label: "/plan",
          description: "Switch to plan mode",
        },
        {
          id: "cmd:default",
          type: "slash-command" as const,
          command: "default",
          label: "/default",
          description: "Switch to default mode",
        },
      ];
      const builtIn = allBuiltIn.filter(
        (item) =>
          item.command.includes(q) &&
          (item.command === "model" || onUpdateInteractionMode !== undefined),
      );

      // A provider expands a slash command only when it opens the whole
      // message; elsewhere it arrives as literal text. Built-ins apply
      // locally and skills insert a `$` mention the server dispatches from
      // any position, so only provider commands are position-gated.
      const providerCommands: ComposerCommandItem[] = [];
      const expandableCommands =
        trigger.rangeStart === 0 ? (selectedProviderStatus?.slashCommands ?? []) : [];
      for (const command of expandableCommands) {
        if (!command.name.toLowerCase().includes(q)) continue;
        // Codex feedback uploads an existing thread's session and logs.
        if (
          !hasThread &&
          selectedProviderStatus?.driver === "codex" &&
          command.name === "feedback"
        ) {
          continue;
        }
        providerCommands.push({
          id: `pcmd:${command.name}`,
          type: "provider-slash-command",
          command,
          label: `/${command.name}`,
          description: command.description ?? "",
        });
      }

      const skillItems = getProviderSkillsForSlashMenu(selectedProviderStatus?.skills ?? [], true)
        .filter((skill) => matchesSlashSkillQuery(skill, q))
        .map((skill) => ({
          id: `skill:${skill.name}`,
          type: "skill" as const,
          skill,
          label: `skill:${skill.name}`,
          description: skill.shortDescription ?? skill.description ?? "",
        }));

      return [...builtIn, ...providerCommands, ...skillItems];
    }

    if (trigger.kind === "skill") {
      const enabledSkills = dedupeProviderSkillsByName(
        (selectedProviderStatus?.skills ?? []).filter(isProviderSkillUserInvocable),
      );
      const normalizedQuery = normalizeSearchQuery(trigger.query, {
        trimLeadingPattern: /^\$+/,
      });

      if (!normalizedQuery) {
        return enabledSkills.slice(0, 20).map((skill) => ({
          id: `skill:${skill.name}`,
          type: "skill" as const,
          skill,
          label: skill.displayName ?? skill.name,
          description: skill.shortDescription ?? skill.description ?? "",
        }));
      }

      const ranked: Array<{
        item: (typeof enabledSkills)[number];
        score: number;
        tieBreaker: string;
      }> = [];
      for (const skill of enabledSkills) {
        const displayLabel = (skill.displayName ?? skill.name).toLowerCase();
        const scores = [
          scoreQueryMatch({
            value: skill.name.toLowerCase(),
            query: normalizedQuery,
            exactBase: 0,
            prefixBase: 2,
            boundaryBase: 4,
            includesBase: 6,
            fuzzyBase: 100,
            boundaryMarkers: ["-", "_", "/"],
          }),
          scoreQueryMatch({
            value: displayLabel,
            query: normalizedQuery,
            exactBase: 1,
            prefixBase: 3,
            boundaryBase: 5,
            includesBase: 7,
            fuzzyBase: 110,
          }),
          scoreQueryMatch({
            value: skill.shortDescription?.toLowerCase() ?? "",
            query: normalizedQuery,
            exactBase: 20,
            prefixBase: 22,
            boundaryBase: 24,
            includesBase: 26,
          }),
          scoreQueryMatch({
            value: skill.description?.toLowerCase() ?? "",
            query: normalizedQuery,
            exactBase: 30,
            prefixBase: 32,
            boundaryBase: 34,
            includesBase: 36,
          }),
        ].filter((score): score is number => score !== null);

        if (scores.length > 0) {
          insertRankedSearchResult(
            ranked,
            {
              item: skill,
              score: Math.min(...scores),
              tieBreaker: `${displayLabel}\u0000${skill.name}`,
            },
            20,
          );
        }
      }

      return ranked.map(({ item: skill }) => ({
        id: `skill:${skill.name}`,
        type: "skill" as const,
        skill,
        label: skill.displayName ?? skill.name,
        description: skill.shortDescription ?? skill.description ?? "",
      }));
    }

    if (trigger.kind === "path") {
      return pathSearch.entries.map((entry) => {
        const parts = entry.path.split("/");
        return {
          id: `path:${entry.path}`,
          type: "path" as const,
          path: entry.path,
          kind: entry.kind,
          label: parts[parts.length - 1] ?? entry.path,
          description: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
        };
      });
    }

    return [];
  }, [hasThread, onUpdateInteractionMode, pathSearch.entries, selectedProviderStatus, trigger]);

  const onSelect = useCallback(
    (item: ComposerCommandItem) => {
      if (!trigger) return;

      if (
        item.type === "slash-command" &&
        (item.command === "plan" || item.command === "default")
      ) {
        const result = replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, "");
        setSelection({ start: result.cursor, end: result.cursor });
        onChangeDraftMessage(result.text);
        onUpdateInteractionMode?.(item.command);
        return;
      }

      let replacement = "";
      if (item.type === "path") {
        replacement = `${serializeComposerFileLink(item.path)} `;
      } else if (item.type === "skill") {
        replacement = `$${item.skill.name} `;
      } else if (item.type === "slash-command") {
        replacement = `/${item.command} `;
      } else if (item.type === "provider-slash-command") {
        replacement = `/${item.command.name} `;
      }

      const result = replaceTextRange(
        draftMessage,
        trigger.rangeStart,
        trigger.rangeEnd,
        replacement,
      );
      setSelection({ start: result.cursor, end: result.cursor });
      onChangeDraftMessage(result.text);
    },
    [draftMessage, onChangeDraftMessage, onUpdateInteractionMode, trigger],
  );

  return {
    selection,
    onSelectionChange,
    trigger,
    items,
    isLoading: pathSearch.isPending,
    onSelect,
  };
}
