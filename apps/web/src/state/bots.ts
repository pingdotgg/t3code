import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const botsListCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:list",
  tag: WS_METHODS.botsList,
});

export const botsCreateCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:create",
  tag: WS_METHODS.botsCreate,
});

export const botsUpdateCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:update",
  tag: WS_METHODS.botsUpdate,
});

export const botsDeleteCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:delete",
  tag: WS_METHODS.botsDelete,
});

export const botsImportFolderCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:import-folder",
  tag: WS_METHODS.botsImportFolder,
});

export const botsOpenChatCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:open-chat",
  tag: WS_METHODS.botsOpenChat,
});

export const botsHandoffCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:handoff",
  tag: WS_METHODS.botsHandoff,
});

export const botsListFilesCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:list-files",
  tag: WS_METHODS.botsListFiles,
});

export const botsReadFileCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:read-file",
  tag: WS_METHODS.botsReadFile,
});

export const botsWriteFileCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:write-file",
  tag: WS_METHODS.botsWriteFile,
});

export const botsListRoutinesCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:list-routines",
  tag: WS_METHODS.botsListRoutines,
});

export const botsUpsertRoutineCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:upsert-routine",
  tag: WS_METHODS.botsUpsertRoutine,
});

export const botsDeleteRoutineCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:delete-routine",
  tag: WS_METHODS.botsDeleteRoutine,
});

export const botsRunRoutineNowCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:run-routine-now",
  tag: WS_METHODS.botsRunRoutineNow,
});

export const botsListGroupsCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:list-groups",
  tag: WS_METHODS.botsListGroups,
});

export const botsCreateGroupCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:create-group",
  tag: WS_METHODS.botsCreateGroup,
});

export const botsDeleteGroupCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:delete-group",
  tag: WS_METHODS.botsDeleteGroup,
});

export const botsListGroupMessagesCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:list-group-messages",
  tag: WS_METHODS.botsListGroupMessages,
});

export const botsSendGroupMessageCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:send-group-message",
  tag: WS_METHODS.botsSendGroupMessage,
});

export const botsListItemsCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:list-items",
  tag: WS_METHODS.botsListItems,
});

export const botsCreateItemCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:create-item",
  tag: WS_METHODS.botsCreateItem,
});

export const botsUpdateItemCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:update-item",
  tag: WS_METHODS.botsUpdateItem,
});

export const botsDeleteItemCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:delete-item",
  tag: WS_METHODS.botsDeleteItem,
});
