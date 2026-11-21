import type {
  Bot,
  BotAvatarColor,
  BotFileEntry,
  BotGroup,
  BotGroupMessage,
  BotId,
  BotItem,
  BotItemStatus,
  BotItemsStaleDays,
  BotRoutine,
  EnvironmentId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import {
  BotIcon,
  FolderInputIcon,
  MessageSquareIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  SendIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  botsCreateCommand,
  botsCreateGroupCommand,
  botsCreateItemCommand,
  botsDeleteCommand,
  botsDeleteGroupCommand,
  botsDeleteItemCommand,
  botsDeleteRoutineCommand,
  botsHandoffCommand,
  botsImportFolderCommand,
  botsListCommand,
  botsListFilesCommand,
  botsListGroupMessagesCommand,
  botsListGroupsCommand,
  botsListItemsCommand,
  botsListRoutinesCommand,
  botsOpenChatCommand,
  botsReadFileCommand,
  botsRunRoutineNowCommand,
  botsSendGroupMessageCommand,
  botsUpdateCommand,
  botsUpdateItemCommand,
  botsUpsertRoutineCommand,
  botsWriteFileCommand,
} from "../../state/bots";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

const AVATAR_COLOR_CLASSES: Record<BotAvatarColor, string> = {
  sky: "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30",
  emerald: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  amber: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  rose: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  violet: "bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/30",
  slate: "bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/30",
  indigo: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border-indigo-500/30",
  teal: "bg-teal-500/15 text-teal-600 dark:text-teal-400 border-teal-500/30",
};

const AVATAR_COLORS: ReadonlyArray<BotAvatarColor> = [
  "sky",
  "emerald",
  "amber",
  "rose",
  "violet",
  "slate",
  "indigo",
  "teal",
];

const RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
];

const STALE_OPTIONS: ReadonlyArray<BotItemsStaleDays> = [3, 5, 7, 14, "never"];

const ITEM_STATUSES: ReadonlyArray<BotItemStatus> = [
  "open",
  "in_progress",
  "stale",
  "done",
  "dismissed",
];

type Selection =
  | { readonly kind: "bot"; readonly botId: BotId }
  | { readonly kind: "group"; readonly groupId: BotGroup["id"] }
  | { readonly kind: "create-bot" }
  | { readonly kind: "import-bot" }
  | { readonly kind: "create-group" }
  | null;

type BotTab = "chat" | "automations" | "items" | "files" | "settings";

function BotAvatarTile({ bot }: { readonly bot: Pick<Bot, "name" | "avatar" | "avatarColor"> }) {
  const label = bot.avatar?.trim() || bot.name.slice(0, 2).toUpperCase();
  return (
    <span
      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-lg border text-xs font-semibold ${AVATAR_COLOR_CLASSES[bot.avatarColor]}`}
    >
      {label}
    </span>
  );
}

export function BotsPage() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const environmentId =
    selectedEnvironmentId !== null &&
    environments.some((env) => env.environmentId === selectedEnvironmentId)
      ? selectedEnvironmentId
      : (primaryEnvironmentId ?? environments[0]?.environmentId ?? null);
  const navigate = useNavigate();
  const gt = useGT();

  const listBots = useAtomCommand(botsListCommand, { reportFailure: true });
  const createBot = useAtomCommand(botsCreateCommand, { reportFailure: true });
  const updateBot = useAtomCommand(botsUpdateCommand, { reportFailure: true });
  const deleteBot = useAtomCommand(botsDeleteCommand, { reportFailure: true });
  const importFolder = useAtomCommand(botsImportFolderCommand, { reportFailure: true });
  const openChat = useAtomCommand(botsOpenChatCommand, { reportFailure: true });
  const handoff = useAtomCommand(botsHandoffCommand, { reportFailure: true });
  const listFiles = useAtomCommand(botsListFilesCommand, { reportFailure: true });
  const readFile = useAtomCommand(botsReadFileCommand, { reportFailure: true });
  const writeFile = useAtomCommand(botsWriteFileCommand, { reportFailure: true });
  const listRoutines = useAtomCommand(botsListRoutinesCommand, { reportFailure: true });
  const upsertRoutine = useAtomCommand(botsUpsertRoutineCommand, { reportFailure: true });
  const deleteRoutine = useAtomCommand(botsDeleteRoutineCommand, { reportFailure: true });
  const runRoutineNow = useAtomCommand(botsRunRoutineNowCommand, { reportFailure: true });
  const listGroups = useAtomCommand(botsListGroupsCommand, { reportFailure: true });
  const createGroup = useAtomCommand(botsCreateGroupCommand, { reportFailure: true });
  const deleteGroup = useAtomCommand(botsDeleteGroupCommand, { reportFailure: true });
  const listGroupMessages = useAtomCommand(botsListGroupMessagesCommand, { reportFailure: true });
  const sendGroupMessage = useAtomCommand(botsSendGroupMessageCommand, { reportFailure: true });
  const listItems = useAtomCommand(botsListItemsCommand, { reportFailure: true });
  const createItem = useAtomCommand(botsCreateItemCommand, { reportFailure: true });
  const updateItem = useAtomCommand(botsUpdateItemCommand, { reportFailure: true });
  const deleteItem = useAtomCommand(botsDeleteItemCommand, { reportFailure: true });

  const [bots, setBots] = useState<ReadonlyArray<Bot>>([]);
  const [groups, setGroups] = useState<ReadonlyArray<BotGroup>>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [activeTab, setActiveTab] = useState<BotTab>("chat");
  const [loadedInitial, setLoadedInitial] = useState(false);

  const [files, setFiles] = useState<ReadonlyArray<BotFileEntry>>([]);
  const [selectedFilePath, setSelectedFilePath] = useState<string>("SOUL.md");
  const [fileContent, setFileContent] = useState("");
  const [newFilePath, setNewFilePath] = useState("");
  const [savingFile, setSavingFile] = useState(false);

  const [routines, setRoutines] = useState<ReadonlyArray<BotRoutine>>([]);
  const [routineTitle, setRoutineTitle] = useState("");
  const [routinePrompt, setRoutinePrompt] = useState("");
  const [routineScheduleType, setRoutineScheduleType] = useState<"interval" | "fixed_time">(
    "interval",
  );
  const [routineEveryMinutes, setRoutineEveryMinutes] = useState("60");
  const [routineTimeOfDay, setRoutineTimeOfDay] = useState("09:00");
  const [routinePrecheck, setRoutinePrecheck] = useState("");

  const [items, setItems] = useState<ReadonlyArray<BotItem>>([]);
  const [itemFilter, setItemFilter] = useState<BotItemStatus | "all">("all");
  const [newItemTitle, setNewItemTitle] = useState("");
  const [newItemSummary, setNewItemSummary] = useState("");

  const [handoffTitle, setHandoffTitle] = useState("");
  const [handoffPrompt, setHandoffPrompt] = useState("");

  const [groupMessages, setGroupMessages] = useState<ReadonlyArray<BotGroupMessage>>([]);
  const [groupDraft, setGroupDraft] = useState("");
  const [lastGroupThreads, setLastGroupThreads] = useState<ReadonlyArray<ThreadId>>([]);

  const [createName, setCreateName] = useState("");
  const [createAvatar, setCreateAvatar] = useState("");
  const [createColor, setCreateColor] = useState<BotAvatarColor>("sky");
  const [createRuntimeMode, setCreateRuntimeMode] = useState<RuntimeMode>("auto-accept-edits");

  const [importPath, setImportPath] = useState("");
  const [importName, setImportName] = useState("");

  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupMembers, setNewGroupMembers] = useState<ReadonlyArray<BotId>>([]);

  const [settingsName, setSettingsName] = useState("");
  const [settingsAvatar, setSettingsAvatar] = useState("");
  const [settingsColor, setSettingsColor] = useState<BotAvatarColor>("sky");
  const [settingsRuntimeMode, setSettingsRuntimeMode] = useState<RuntimeMode>("auto-accept-edits");
  const [settingsTidyUp, setSettingsTidyUp] = useState(true);
  const [settingsTidyTime, setSettingsTidyTime] = useState("02:00");
  const [settingsStaleDays, setSettingsStaleDays] = useState<BotItemsStaleDays>(5);

  const navigateToThread = (envId: EnvironmentId, threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: envId, threadId },
    });
  };

  const applyBotSettings = (bot: Bot) => {
    setSettingsName(bot.name);
    setSettingsAvatar(bot.avatar ?? "");
    setSettingsColor(bot.avatarColor);
    setSettingsRuntimeMode(bot.runtimeMode);
    setSettingsTidyUp(bot.tidyUpEnabled);
    setSettingsTidyTime(bot.tidyUpTimeOfDay);
    setSettingsStaleDays(bot.itemsStaleDays);
  };

  const loadBotDetails = async (envId: EnvironmentId, bot: Bot) => {
    applyBotSettings(bot);
    const [filesExit, routinesExit, itemsExit, soulExit] = await Promise.all([
      listFiles({ environmentId: envId, input: { botId: bot.id } }),
      listRoutines({ environmentId: envId, input: { botId: bot.id } }),
      listItems({ environmentId: envId, input: { botId: bot.id } }),
      readFile({ environmentId: envId, input: { botId: bot.id, relativePath: "SOUL.md" } }),
    ]);
    if (filesExit._tag === "Success") setFiles(filesExit.value.files);
    if (routinesExit._tag === "Success") setRoutines(routinesExit.value.routines);
    if (itemsExit._tag === "Success") setItems(itemsExit.value.items);
    if (soulExit._tag === "Success") {
      setSelectedFilePath("SOUL.md");
      setFileContent(soulExit.value.content);
    }
  };

  const loadGroupDetails = async (envId: EnvironmentId, groupId: BotGroup["id"]) => {
    const exit = await listGroupMessages({ environmentId: envId, input: { groupId, limit: 100 } });
    if (exit._tag === "Success") {
      setGroupMessages(exit.value.messages);
    }
  };

  const refreshSidebarData = async () => {
    if (!environmentId) return;
    const [botsExit, groupsExit] = await Promise.all([
      listBots({ environmentId, input: undefined }),
      listGroups({ environmentId, input: undefined }),
    ]);
    setLoadedInitial(true);
    if (botsExit._tag === "Success") {
      setBots(botsExit.value.bots);
      const first = botsExit.value.bots[0];
      if (selection === null && first) {
        setSelection({ kind: "bot", botId: first.id });
        await loadBotDetails(environmentId, first);
      }
    }
    if (groupsExit._tag === "Success") {
      setGroups(groupsExit.value.groups);
    }
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches initial bots and groups when primary environment connects
  useEffect(() => {
    if (!environmentId) return;
    let cancelled = false;
    void (async () => {
      const [botsExit, groupsExit] = await Promise.all([
        listBots({ environmentId, input: undefined }),
        listGroups({ environmentId, input: undefined }),
      ]);
      if (cancelled) return;
      setLoadedInitial(true);
      if (botsExit._tag === "Success") {
        setBots(botsExit.value.bots);
        const first = botsExit.value.bots[0];
        if (first) {
          setSelection((prev) => prev ?? { kind: "bot", botId: first.id });
          const [filesExit, routinesExit, itemsExit, soulExit] = await Promise.all([
            listFiles({ environmentId, input: { botId: first.id } }),
            listRoutines({ environmentId, input: { botId: first.id } }),
            listItems({ environmentId, input: { botId: first.id } }),
            readFile({ environmentId, input: { botId: first.id, relativePath: "SOUL.md" } }),
          ]);
          if (cancelled) return;
          setSettingsName(first.name);
          setSettingsAvatar(first.avatar ?? "");
          setSettingsColor(first.avatarColor);
          setSettingsRuntimeMode(first.runtimeMode);
          setSettingsTidyUp(first.tidyUpEnabled);
          setSettingsTidyTime(first.tidyUpTimeOfDay);
          setSettingsStaleDays(first.itemsStaleDays);
          if (filesExit._tag === "Success") setFiles(filesExit.value.files);
          if (routinesExit._tag === "Success") setRoutines(routinesExit.value.routines);
          if (itemsExit._tag === "Success") setItems(itemsExit.value.items);
          if (soulExit._tag === "Success") {
            setSelectedFilePath("SOUL.md");
            setFileContent(soulExit.value.content);
          }
        }
      }
      if (groupsExit._tag === "Success") {
        setGroups(groupsExit.value.groups);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [environmentId, listBots, listGroups, listFiles, listRoutines, listItems, readFile]);

  const selectedBot =
    selection?.kind === "bot" ? (bots.find((b) => b.id === selection.botId) ?? null) : null;
  const selectedGroup =
    selection?.kind === "group" ? (groups.find((g) => g.id === selection.groupId) ?? null) : null;

  const handleSelectBot = (bot: Bot) => {
    setSelection({ kind: "bot", botId: bot.id });
    if (environmentId) {
      void loadBotDetails(environmentId, bot);
    }
  };

  const handleSelectGroup = (group: BotGroup) => {
    setSelection({ kind: "group", groupId: group.id });
    setLastGroupThreads([]);
    if (environmentId) {
      void loadGroupDetails(environmentId, group.id);
    }
  };

  const handleCreateBot = async () => {
    if (!environmentId || !createName.trim()) return;
    const exit = await createBot({
      environmentId,
      input: {
        name: createName.trim(),
        avatar: createAvatar.trim() || null,
        avatarColor: createColor,
        runtimeMode: createRuntimeMode,
      },
    });
    if (exit._tag === "Success") {
      setCreateName("");
      setCreateAvatar("");
      await refreshSidebarData();
      setSelection({ kind: "bot", botId: exit.value.id });
      setActiveTab("chat");
      await loadBotDetails(environmentId, exit.value);
    }
  };

  const handleImportBot = async () => {
    if (!environmentId || !importPath.trim()) return;
    const exit = await importFolder({
      environmentId,
      input: {
        sourcePath: importPath.trim(),
        ...(importName.trim() ? { name: importName.trim() } : {}),
      },
    });
    if (exit._tag === "Success") {
      setImportPath("");
      setImportName("");
      await refreshSidebarData();
      setSelection({ kind: "bot", botId: exit.value.id });
      setActiveTab("files");
      await loadBotDetails(environmentId, exit.value);
    }
  };

  const handleCreateGroup = async () => {
    if (!environmentId || !newGroupName.trim() || newGroupMembers.length === 0) return;
    const exit = await createGroup({
      environmentId,
      input: { name: newGroupName.trim(), memberBotIds: [...newGroupMembers] },
    });
    if (exit._tag === "Success") {
      setNewGroupName("");
      setNewGroupMembers([]);
      await refreshSidebarData();
      setSelection({ kind: "group", groupId: exit.value.id });
      await loadGroupDetails(environmentId, exit.value.id);
    }
  };

  const handleOpenChat = async (bot: Bot, initialPrompt?: string) => {
    if (!environmentId) return;
    const exit = await openChat({
      environmentId,
      input: { botId: bot.id, ...(initialPrompt ? { initialPrompt } : {}) },
    });
    if (exit._tag === "Success") {
      await refreshSidebarData();
      navigateToThread(environmentId, exit.value.threadId);
    }
  };

  const handleHandoff = async (bot: Bot) => {
    if (!environmentId || !handoffTitle.trim() || !handoffPrompt.trim()) return;
    const exit = await handoff({
      environmentId,
      input: {
        targetBotId: bot.id,
        title: handoffTitle.trim(),
        prompt: handoffPrompt.trim(),
      },
    });
    if (exit._tag === "Success") {
      setHandoffTitle("");
      setHandoffPrompt("");
      await loadBotDetails(environmentId, bot);
      navigateToThread(environmentId, exit.value.threadId);
    }
  };

  const handleSelectFile = async (bot: Bot, relativePath: string) => {
    if (!environmentId) return;
    setSelectedFilePath(relativePath);
    const exit = await readFile({ environmentId, input: { botId: bot.id, relativePath } });
    if (exit._tag === "Success") {
      setFileContent(exit.value.content);
    }
  };

  const handleSaveFile = async (bot: Bot) => {
    if (!environmentId || !selectedFilePath.trim()) return;
    setSavingFile(true);
    const exit = await writeFile({
      environmentId,
      input: { botId: bot.id, relativePath: selectedFilePath, content: fileContent },
    });
    setSavingFile(false);
    if (exit._tag === "Success") {
      const filesExit = await listFiles({ environmentId, input: { botId: bot.id } });
      if (filesExit._tag === "Success") setFiles(filesExit.value.files);
    }
  };

  const handleCreateNewFile = async (bot: Bot) => {
    if (!environmentId || !newFilePath.trim()) return;
    const targetPath = newFilePath.trim();
    const exit = await writeFile({
      environmentId,
      input: { botId: bot.id, relativePath: targetPath, content: "" },
    });
    if (exit._tag === "Success") {
      setNewFilePath("");
      setSelectedFilePath(exit.value.relativePath);
      setFileContent("");
      const filesExit = await listFiles({ environmentId, input: { botId: bot.id } });
      if (filesExit._tag === "Success") setFiles(filesExit.value.files);
    }
  };

  const handleAddRoutine = async (bot: Bot) => {
    if (!environmentId || !routineTitle.trim() || !routinePrompt.trim()) return;
    const schedule =
      routineScheduleType === "interval"
        ? {
            type: "interval" as const,
            everyMs: Math.max(1, Number(routineEveryMinutes) || 60) * 60_000,
          }
        : {
            type: "fixed_time" as const,
            timeOfDay: routineTimeOfDay,
          };
    const exit = await upsertRoutine({
      environmentId,
      input: {
        botId: bot.id,
        title: routineTitle.trim(),
        prompt: routinePrompt.trim(),
        enabled: true,
        schedule,
        precheckCommand: routinePrecheck.trim() || null,
      },
    });
    if (exit._tag === "Success") {
      setRoutineTitle("");
      setRoutinePrompt("");
      setRoutinePrecheck("");
      const routinesExit = await listRoutines({ environmentId, input: { botId: bot.id } });
      if (routinesExit._tag === "Success") setRoutines(routinesExit.value.routines);
    }
  };

  const handleToggleRoutine = async (bot: Bot, routine: BotRoutine) => {
    if (!environmentId) return;
    const exit = await upsertRoutine({
      environmentId,
      input: {
        routineId: routine.id,
        botId: bot.id,
        title: routine.title,
        prompt: routine.prompt,
        enabled: !routine.enabled,
        schedule: routine.schedule,
        precheckCommand: routine.precheckCommand,
      },
    });
    if (exit._tag === "Success") {
      const routinesExit = await listRoutines({ environmentId, input: { botId: bot.id } });
      if (routinesExit._tag === "Success") setRoutines(routinesExit.value.routines);
    }
  };

  const handleRunRoutineNow = async (bot: Bot, routine: BotRoutine) => {
    if (!environmentId) return;
    const exit = await runRoutineNow({
      environmentId,
      input: { routineId: routine.id, bypassPrecheck: false },
    });
    if (exit._tag === "Success") {
      await loadBotDetails(environmentId, bot);
    }
  };

  const handleDeleteRoutine = async (bot: Bot, routine: BotRoutine) => {
    if (!environmentId) return;
    const exit = await deleteRoutine({ environmentId, input: { routineId: routine.id } });
    if (exit._tag === "Success") {
      const routinesExit = await listRoutines({ environmentId, input: { botId: bot.id } });
      if (routinesExit._tag === "Success") setRoutines(routinesExit.value.routines);
    }
  };

  const handleCreateItem = async (bot: Bot) => {
    if (!environmentId || !newItemTitle.trim()) return;
    const exit = await createItem({
      environmentId,
      input: {
        botId: bot.id,
        title: newItemTitle.trim(),
        summary: newItemSummary.trim(),
      },
    });
    if (exit._tag === "Success") {
      setNewItemTitle("");
      setNewItemSummary("");
      const itemsExit = await listItems({ environmentId, input: { botId: bot.id } });
      if (itemsExit._tag === "Success") setItems(itemsExit.value.items);
    }
  };

  const handleUpdateItemStatus = async (bot: Bot, item: BotItem, status: BotItemStatus) => {
    if (!environmentId) return;
    const exit = await updateItem({
      environmentId,
      input: { itemId: item.id, status },
    });
    if (exit._tag === "Success") {
      const itemsExit = await listItems({ environmentId, input: { botId: bot.id } });
      if (itemsExit._tag === "Success") setItems(itemsExit.value.items);
    }
  };

  const handleDeleteItem = async (bot: Bot, item: BotItem) => {
    if (!environmentId) return;
    const exit = await deleteItem({ environmentId, input: { itemId: item.id } });
    if (exit._tag === "Success") {
      const itemsExit = await listItems({ environmentId, input: { botId: bot.id } });
      if (itemsExit._tag === "Success") setItems(itemsExit.value.items);
    }
  };

  const handleSaveSettings = async (bot: Bot) => {
    if (!environmentId || !settingsName.trim()) return;
    const exit = await updateBot({
      environmentId,
      input: {
        botId: bot.id,
        name: settingsName.trim(),
        avatar: settingsAvatar.trim() || null,
        avatarColor: settingsColor,
        runtimeMode: settingsRuntimeMode,
        tidyUpEnabled: settingsTidyUp,
        tidyUpTimeOfDay: settingsTidyTime,
        itemsStaleDays: settingsStaleDays,
      },
    });
    if (exit._tag === "Success") {
      await refreshSidebarData();
      await loadBotDetails(environmentId, exit.value);
    }
  };

  const handleTogglePaused = async (bot: Bot) => {
    if (!environmentId) return;
    const exit = await updateBot({
      environmentId,
      input: { botId: bot.id, paused: !bot.paused },
    });
    if (exit._tag === "Success") {
      await refreshSidebarData();
    }
  };

  const handleDeleteBot = async (bot: Bot, removeHomeDirectory: boolean) => {
    if (!environmentId) return;
    const exit = await deleteBot({
      environmentId,
      input: { botId: bot.id, removeHomeDirectory },
    });
    if (exit._tag === "Success") {
      setSelection(null);
      await refreshSidebarData();
    }
  };

  const handleSendGroupMessage = async (group: BotGroup) => {
    if (!environmentId || !groupDraft.trim()) return;
    const exit = await sendGroupMessage({
      environmentId,
      input: { groupId: group.id, body: groupDraft.trim() },
    });
    if (exit._tag === "Success") {
      setGroupDraft("");
      setLastGroupThreads(exit.value.threadIds);
      await loadGroupDetails(environmentId, group.id);
    }
  };

  const handleDeleteGroup = async (group: BotGroup) => {
    if (!environmentId) return;
    const exit = await deleteGroup({ environmentId, input: { groupId: group.id } });
    if (exit._tag === "Success") {
      setSelection(null);
      await refreshSidebarData();
    }
  };

  const visibleItems =
    itemFilter === "all" ? items : items.filter((item) => item.status === itemFilter);

  const tabLabel = (tab: BotTab) => {
    switch (tab) {
      case "chat":
        return gt("Chat & Handoff");
      case "automations":
        return gt("Automations ({count})", { count: routines.length });
      case "items":
        return gt("Items ({count})", { count: items.length });
      case "files":
        return gt("Files ({count})", { count: files.length });
      case "settings":
        return gt("Settings");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden bg-background">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-card/30">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <BotIcon className="size-4" />
            <span>
              <T>Bots</T>
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={gt("Refresh bots")}
              onClick={() => void refreshSidebarData()}
            >
              <RefreshCwIcon className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={gt("Import bot folder")}
              onClick={() => setSelection({ kind: "import-bot" })}
            >
              <FolderInputIcon className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="secondary"
              aria-label={gt("New bot")}
              onClick={() => setSelection({ kind: "create-bot" })}
            >
              <PlusIcon className="size-3.5" />
            </Button>
          </div>
        </div>

        {environments.length > 0 ? (
          <div className="border-b border-border px-3 py-2">
            <select
              aria-label={gt("Environment")}
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
              value={environmentId ?? ""}
              onChange={(e) => {
                const nextId = e.target.value as EnvironmentId;
                setSelectedEnvironmentId(nextId);
                setSelection(null);
                setBots([]);
                setGroups([]);
                setFiles([]);
                setRoutines([]);
                setItems([]);
                setGroupMessages([]);
                setLastGroupThreads([]);
                setLoadedInitial(false);
              }}
            >
              {environments.map((env) => (
                <option key={env.environmentId} value={env.environmentId}>
                  {env.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="flex-1 overflow-y-auto p-2">
          <div className="space-y-1">
            {bots.map((bot) => {
              const isSelected = selection?.kind === "bot" && selection.botId === bot.id;
              return (
                <button
                  key={bot.id}
                  type="button"
                  onClick={() => handleSelectBot(bot)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    isSelected
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50 text-foreground"
                  }`}
                >
                  <BotAvatarTile bot={bot} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{bot.name}</span>
                      {bot.paused ? (
                        <Badge size="sm" variant="secondary">
                          <T>Paused</T>
                        </Badge>
                      ) : null}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{`@${bot.slug}`}</div>
                  </div>
                </button>
              );
            })}
            {bots.length === 0 && loadedInitial ? (
              <div className="px-2 py-4 text-xs text-muted-foreground">
                <T>No bots yet. Create one or import a bot folder.</T>
              </div>
            ) : null}
          </div>

          <div className="mt-5 flex items-center justify-between px-2 py-1.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <UsersIcon className="size-3.5" />
              <T>Group Chats</T>
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={gt("New group chat")}
              onClick={() => setSelection({ kind: "create-group" })}
            >
              <PlusIcon className="size-3.5" />
            </Button>
          </div>

          <div className="space-y-1">
            {groups.map((group) => {
              const isSelected = selection?.kind === "group" && selection.groupId === group.id;
              return (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => handleSelectGroup(group)}
                  className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                    isSelected
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50 text-foreground"
                  }`}
                >
                  <span className="truncate font-medium">{group.name}</span>
                  <Badge size="sm" variant="outline">
                    {group.memberBotIds.length}
                  </Badge>
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {selection?.kind === "create-bot" ? (
          <div className="max-w-xl space-y-4 p-6">
            <h1 className="text-lg font-semibold">
              <T>Create Bot</T>
            </h1>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  <T>Name</T>
                </label>
                <Input
                  placeholder={gt("PR Reviewer")}
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    <T>Avatar (emoji or initials)</T>
                  </label>
                  <Input
                    placeholder={gt("PR")}
                    value={createAvatar}
                    onChange={(e) => setCreateAvatar(e.target.value)}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    <T>Runtime Mode</T>
                  </label>
                  <select
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={createRuntimeMode}
                    onChange={(e) => setCreateRuntimeMode(e.target.value as RuntimeMode)}
                  >
                    {RUNTIME_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {mode}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  <T>Avatar Color</T>
                </label>
                <div className="flex flex-wrap gap-2">
                  {AVATAR_COLORS.map((color) => (
                    <Button
                      key={color}
                      size="sm"
                      variant={createColor === color ? "default" : "outline"}
                      onClick={() => setCreateColor(color)}
                    >
                      {color}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="flex gap-2 pt-2">
                <Button onClick={() => void handleCreateBot()}>
                  <T>Create Bot</T>
                </Button>
                <Button variant="ghost" onClick={() => setSelection(null)}>
                  <T>Cancel</T>
                </Button>
              </div>
            </div>
          </div>
        ) : selection?.kind === "import-bot" ? (
          <div className="max-w-xl space-y-4 p-6">
            <h1 className="text-lg font-semibold">
              <T>Import Bot Folder</T>
            </h1>
            <p className="text-sm text-muted-foreground">
              <T>Point to a local folder containing SOUL.md and optional skills/.</T>
            </p>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  <T>Source Folder Path</T>
                </label>
                <Input
                  placeholder={gt("/path/to/bots/pr-reviewer")}
                  value={importPath}
                  onChange={(e) => setImportPath(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  <T>Display Name (optional)</T>
                </label>
                <Input
                  placeholder={gt("PR Reviewer")}
                  value={importName}
                  onChange={(e) => setImportName(e.target.value)}
                />
              </div>
              <div className="flex gap-2 pt-2">
                <Button onClick={() => void handleImportBot()}>
                  <T>Import Bot</T>
                </Button>
                <Button variant="ghost" onClick={() => setSelection(null)}>
                  <T>Cancel</T>
                </Button>
              </div>
            </div>
          </div>
        ) : selection?.kind === "create-group" ? (
          <div className="max-w-xl space-y-4 p-6">
            <h1 className="text-lg font-semibold">
              <T>Create Group Chat</T>
            </h1>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  <T>Group Name</T>
                </label>
                <Input
                  placeholder={gt("Engineering Delivery")}
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  <T>Member Bots</T>
                </label>
                <div className="space-y-1.5">
                  {bots.map((bot) => {
                    const checked = newGroupMembers.includes(bot.id);
                    return (
                      <label key={bot.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setNewGroupMembers((prev) =>
                              checked ? prev.filter((id) => id !== bot.id) : [...prev, bot.id],
                            )
                          }
                        />
                        <span>{bot.name}</span>
                        <span className="text-xs text-muted-foreground">{`@${bot.slug}`}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
              <div className="flex gap-2 pt-2">
                <Button onClick={() => void handleCreateGroup()}>
                  <T>Create Group</T>
                </Button>
                <Button variant="ghost" onClick={() => setSelection(null)}>
                  <T>Cancel</T>
                </Button>
              </div>
            </div>
          </div>
        ) : selectedBot ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <header className="flex items-center justify-between border-b border-border px-6 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <BotAvatarTile bot={selectedBot} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h1 className="truncate text-base font-semibold">{selectedBot.name}</h1>
                    <Badge size="sm" variant="outline">
                      {`@${selectedBot.slug}`}
                    </Badge>
                    {selectedBot.paused ? (
                      <Badge size="sm" variant="secondary">
                        <T>Paused</T>
                      </Badge>
                    ) : null}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {selectedBot.homePath}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handleTogglePaused(selectedBot)}
                >
                  {selectedBot.paused ? (
                    <>
                      <PlayIcon className="size-3.5" />
                      <T>Resume</T>
                    </>
                  ) : (
                    <>
                      <PauseIcon className="size-3.5" />
                      <T>Pause</T>
                    </>
                  )}
                </Button>
                <Button size="sm" onClick={() => void handleOpenChat(selectedBot)}>
                  <MessageSquareIcon className="size-3.5" />
                  <T>Open Chat</T>
                </Button>
              </div>
            </header>

            <div className="flex gap-1 border-b border-border px-6 py-2">
              {(["chat", "automations", "items", "files", "settings"] as const).map((tab) => (
                <Button
                  key={tab}
                  size="sm"
                  variant={activeTab === tab ? "secondary" : "ghost"}
                  onClick={() => setActiveTab(tab)}
                >
                  {tabLabel(tab)}
                </Button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              {activeTab === "chat" ? (
                <div className="max-w-2xl space-y-6">
                  {selectedBot.firstRun ? (
                    <div className="rounded-lg border border-border bg-muted/40 p-4">
                      <div className="text-sm font-medium">
                        <T>First-run setup ready</T>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        <T>
                          Open Chat to run the onboarding interview and author SOUL.md with this
                          bot.
                        </T>
                      </p>
                    </div>
                  ) : null}

                  <div className="space-y-3 rounded-lg border border-border p-4">
                    <div className="text-sm font-semibold">
                      <T>Dispatch Handoff</T>
                    </div>
                    <Input
                      placeholder={gt("Task title (e.g. Review PR #412)")}
                      value={handoffTitle}
                      onChange={(e) => setHandoffTitle(e.target.value)}
                    />
                    <Textarea
                      placeholder={gt("Describe the task, repo, or context to hand off...")}
                      rows={4}
                      value={handoffPrompt}
                      onChange={(e) => setHandoffPrompt(e.target.value)}
                    />
                    <Button onClick={() => void handleHandoff(selectedBot)}>
                      <SendIcon className="size-3.5" />
                      <T>Send Handoff</T>
                    </Button>
                  </div>
                </div>
              ) : activeTab === "automations" ? (
                <div className="max-w-3xl space-y-6">
                  <div className="space-y-2">
                    {routines.map((routine) => (
                      <div
                        key={routine.id}
                        className="flex flex-col gap-2 rounded-lg border border-border p-4"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold">{routine.title}</span>
                            {routine.isTidyUp ? (
                              <Badge size="sm" variant="secondary">
                                <T>Tidy-up</T>
                              </Badge>
                            ) : null}
                            <Badge size="sm" variant={routine.enabled ? "default" : "outline"}>
                              {routine.enabled ? gt("Enabled") : gt("Paused")}
                            </Badge>
                            <Badge size="sm" variant="outline">
                              {routine.lastRunStatus}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void handleRunRoutineNow(selectedBot, routine)}
                            >
                              <T>Run Now</T>
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void handleToggleRoutine(selectedBot, routine)}
                            >
                              {routine.enabled ? gt("Pause") : gt("Enable")}
                            </Button>
                            {!routine.isTidyUp ? (
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={gt("Delete routine")}
                                onClick={() => void handleDeleteRoutine(selectedBot, routine)}
                              >
                                <Trash2Icon className="size-3.5" />
                              </Button>
                            ) : null}
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground">{routine.prompt}</p>
                        {routine.precheckCommand ? (
                          <div className="rounded bg-muted px-2 py-1 font-mono text-xs">
                            {gt("precheck: {cmd}", { cmd: routine.precheckCommand })}
                          </div>
                        ) : null}
                        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          <span>{gt("Runs: {count}", { count: routine.runCount })}</span>
                          {routine.nextRunAt ? (
                            <span>{gt("Next: {time}", { time: routine.nextRunAt })}</span>
                          ) : null}
                          {routine.lastRunThreadId && environmentId ? (
                            <Button
                              size="sm"
                              variant="link"
                              onClick={() =>
                                navigateToThread(environmentId, routine.lastRunThreadId!)
                              }
                            >
                              <T>Open last run thread</T>
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="space-y-3 rounded-lg border border-border p-4">
                    <div className="text-sm font-semibold">
                      <T>Add Automation</T>
                    </div>
                    <Input
                      placeholder={gt("Routine title (e.g. Review open PRs)")}
                      value={routineTitle}
                      onChange={(e) => setRoutineTitle(e.target.value)}
                    />
                    <Textarea
                      placeholder={gt("Prompt to run when scheduled...")}
                      rows={3}
                      value={routinePrompt}
                      onChange={(e) => setRoutinePrompt(e.target.value)}
                    />
                    <div className="grid grid-cols-2 gap-3">
                      <select
                        className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                        value={routineScheduleType}
                        onChange={(e) =>
                          setRoutineScheduleType(e.target.value as "interval" | "fixed_time")
                        }
                      >
                        <option value="interval">{gt("Interval (minutes)")}</option>
                        <option value="fixed_time">{gt("Daily time (HH:MM)")}</option>
                      </select>
                      {routineScheduleType === "interval" ? (
                        <Input
                          type="number"
                          min={1}
                          value={routineEveryMinutes}
                          onChange={(e) => setRoutineEveryMinutes(e.target.value)}
                        />
                      ) : (
                        <Input
                          placeholder={gt("09:00")}
                          value={routineTimeOfDay}
                          onChange={(e) => setRoutineTimeOfDay(e.target.value)}
                        />
                      )}
                    </div>
                    <Input
                      placeholder={gt(
                        "Optional precheck shell command (skips run if unchanged or non-zero)",
                      )}
                      value={routinePrecheck}
                      onChange={(e) => setRoutinePrecheck(e.target.value)}
                    />
                    <Button onClick={() => void handleAddRoutine(selectedBot)}>
                      <PlusIcon className="size-3.5" />
                      <T>Add Routine</T>
                    </Button>
                  </div>
                </div>
              ) : activeTab === "items" ? (
                <div className="max-w-3xl space-y-5">
                  <div className="flex flex-wrap gap-1.5">
                    {(["all", ...ITEM_STATUSES] as const).map((status) => (
                      <Button
                        key={status}
                        size="sm"
                        variant={itemFilter === status ? "secondary" : "ghost"}
                        onClick={() => setItemFilter(status)}
                      >
                        {status}
                      </Button>
                    ))}
                  </div>

                  <div className="space-y-2">
                    {visibleItems.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-start justify-between gap-3 rounded-lg border border-border p-3"
                      >
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{item.title}</span>
                            <Badge size="sm" variant="outline">
                              {item.source}
                            </Badge>
                          </div>
                          {item.summary ? (
                            <p className="text-xs text-muted-foreground">{item.summary}</p>
                          ) : null}
                          {item.threadId && environmentId ? (
                            <Button
                              size="sm"
                              variant="link"
                              onClick={() => navigateToThread(environmentId, item.threadId!)}
                            >
                              <T>Open thread</T>
                            </Button>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2">
                          <select
                            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                            value={item.status}
                            onChange={(e) =>
                              void handleUpdateItemStatus(
                                selectedBot,
                                item,
                                e.target.value as BotItemStatus,
                              )
                            }
                          >
                            {ITEM_STATUSES.map((status) => (
                              <option key={status} value={status}>
                                {status}
                              </option>
                            ))}
                          </select>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={gt("Delete item")}
                            onClick={() => void handleDeleteItem(selectedBot, item)}
                          >
                            <Trash2Icon className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="space-y-2 rounded-lg border border-border p-4">
                    <div className="text-sm font-semibold">
                      <T>Add Work Item</T>
                    </div>
                    <Input
                      placeholder={gt("Item title")}
                      value={newItemTitle}
                      onChange={(e) => setNewItemTitle(e.target.value)}
                    />
                    <Textarea
                      placeholder={gt("Notes or context...")}
                      rows={2}
                      value={newItemSummary}
                      onChange={(e) => setNewItemSummary(e.target.value)}
                    />
                    <Button size="sm" onClick={() => void handleCreateItem(selectedBot)}>
                      <T>Add Item</T>
                    </Button>
                  </div>
                </div>
              ) : activeTab === "files" ? (
                <div className="grid h-full min-h-[420px] grid-cols-12 gap-4">
                  <div className="col-span-4 flex flex-col gap-2 border-r border-border pr-4">
                    <div className="space-y-1">
                      {files.map((file) => (
                        <button
                          key={file.relativePath}
                          type="button"
                          onClick={() => void handleSelectFile(selectedBot, file.relativePath)}
                          className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs ${
                            selectedFilePath === file.relativePath
                              ? "bg-accent font-medium text-accent-foreground"
                              : "hover:bg-accent/50"
                          }`}
                        >
                          <span className="truncate font-mono">{file.relativePath}</span>
                          <Badge size="sm" variant="outline">
                            {file.kind}
                          </Badge>
                        </button>
                      ))}
                    </div>
                    <div className="mt-3 flex gap-1.5">
                      <Input
                        placeholder={gt("skills/review/SKILL.md")}
                        value={newFilePath}
                        onChange={(e) => setNewFilePath(e.target.value)}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleCreateNewFile(selectedBot)}
                      >
                        <T>Add</T>
                      </Button>
                    </div>
                  </div>
                  <div className="col-span-8 flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs font-medium">{selectedFilePath}</span>
                      <Button
                        size="sm"
                        disabled={savingFile}
                        onClick={() => void handleSaveFile(selectedBot)}
                      >
                        <SaveIcon className="size-3.5" />
                        <T>Save</T>
                      </Button>
                    </div>
                    <Textarea
                      rows={18}
                      value={fileContent}
                      onChange={(e) => setFileContent(e.target.value)}
                    />
                  </div>
                </div>
              ) : (
                <div className="max-w-xl space-y-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      <T>Name</T>
                    </label>
                    <Input value={settingsName} onChange={(e) => setSettingsName(e.target.value)} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        <T>Avatar</T>
                      </label>
                      <Input
                        value={settingsAvatar}
                        onChange={(e) => setSettingsAvatar(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        <T>Runtime Mode</T>
                      </label>
                      <select
                        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                        value={settingsRuntimeMode}
                        onChange={(e) => setSettingsRuntimeMode(e.target.value as RuntimeMode)}
                      >
                        {RUNTIME_MODES.map((mode) => (
                          <option key={mode} value={mode}>
                            {mode}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {AVATAR_COLORS.map((color) => (
                      <Button
                        key={color}
                        size="sm"
                        variant={settingsColor === color ? "default" : "outline"}
                        onClick={() => setSettingsColor(color)}
                      >
                        {color}
                      </Button>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={settingsTidyUp}
                        onChange={(e) => setSettingsTidyUp(e.target.checked)}
                      />
                      <T>Nightly memory tidy-up</T>
                    </label>
                    <Input
                      value={settingsTidyTime}
                      onChange={(e) => setSettingsTidyTime(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      <T>Mark untouched items stale after (days)</T>
                    </label>
                    <select
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={String(settingsStaleDays)}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setSettingsStaleDays(
                          raw === "never" ? "never" : (Number(raw) as BotItemsStaleDays),
                        );
                      }}
                    >
                      {STALE_OPTIONS.map((opt) => (
                        <option key={String(opt)} value={String(opt)}>
                          {opt === "never" ? gt("Never") : gt("{days} days", { days: opt })}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center justify-between pt-3">
                    <Button onClick={() => void handleSaveSettings(selectedBot)}>
                      <T>Save Settings</T>
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => void handleDeleteBot(selectedBot, false)}
                    >
                      <T>Delete Bot</T>
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : selectedGroup ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <header className="flex items-center justify-between border-b border-border px-6 py-4">
              <div>
                <h1 className="text-base font-semibold">{selectedGroup.name}</h1>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {selectedGroup.memberBotIds.map((memberId) => {
                    const member = bots.find((b) => b.id === memberId);
                    return member ? (
                      <Badge key={memberId} size="sm" variant="secondary">
                        {`@${member.slug}`}
                      </Badge>
                    ) : null;
                  })}
                </div>
              </div>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void handleDeleteGroup(selectedGroup)}
              >
                <T>Delete Group</T>
              </Button>
            </header>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-6">
              {groupMessages.map((msg) => (
                <div key={msg.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">{msg.senderName}</span>
                    <span>{msg.createdAt}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{msg.body}</p>
                </div>
              ))}
              {lastGroupThreads.length > 0 && environmentId ? (
                <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 p-3 text-xs">
                  <span>
                    <T>Dispatched bot threads:</T>
                  </span>
                  {lastGroupThreads.map((threadId) => (
                    <Button
                      key={threadId}
                      size="sm"
                      variant="outline"
                      onClick={() => navigateToThread(environmentId, threadId)}
                    >
                      {threadId}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="flex gap-2 border-t border-border p-4">
              <Input
                placeholder={gt("Message group... use @slug or @all to route to specific bots")}
                value={groupDraft}
                onChange={(e) => setGroupDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSendGroupMessage(selectedGroup);
                  }
                }}
              />
              <Button onClick={() => void handleSendGroupMessage(selectedGroup)}>
                <SendIcon className="size-3.5" />
                <T>Send</T>
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <BotIcon className="size-10 text-muted-foreground" />
            <div className="text-base font-semibold">
              <T>Bots</T>
            </div>
            <p className="max-w-md text-sm text-muted-foreground">
              <T>
                Create persistent bots with their own SOUL.md, MEMORY.md, skills, scheduled routines
                with prechecks, work item queues, and multi-bot group chats.
              </T>
            </p>
            <div className="flex gap-2">
              <Button onClick={() => setSelection({ kind: "create-bot" })}>
                <PlusIcon className="size-3.5" />
                <T>Create Bot</T>
              </Button>
              <Button variant="outline" onClick={() => setSelection({ kind: "import-bot" })}>
                <FolderInputIcon className="size-3.5" />
                <T>Import Bot</T>
              </Button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
