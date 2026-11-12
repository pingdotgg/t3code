import { expect, it } from "vite-plus/test";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";

it.each([
  {
    type: "message.dispatch",
    text: "!ls",
    createdBy: "user",
    creationSource: "web",
    terminal: true,
  },
  {
    type: "message.dispatch",
    text: "!ls",
    createdBy: "user",
    creationSource: "mobile",
    terminal: true,
  },
  {
    type: "message.dispatch",
    text: "!",
    createdBy: "user",
    creationSource: "web",
    terminal: false,
  },
  {
    type: "message.dispatch",
    text: "!ls",
    createdBy: "agent",
    creationSource: "mcp",
    terminal: false,
  },
  {
    type: "message.dispatch",
    text: "!ls",
    createdBy: "agent",
    creationSource: "web",
    terminal: true,
  },
  { type: "message.dispatch", text: "!ls", terminal: true },
  {
    type: "message.dispatch",
    text: "!ls",
    createdBy: "user",
    creationSource: "web",
    scheduledTaskId: "task",
    terminal: false,
  },
  { type: "shell-command.stop", terminal: true },
  { type: "queued-run.edit", text: "!ls", terminal: true },
  { type: "queued-run.edit", text: "plain", terminal: false },
  { type: "shell-command.delivery.set", terminal: false },
])("requires terminal permission for executable shell commands: %j", ({ terminal, ...input }) => {
  expect(clientRpcRequiredScopes(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, input)).toEqual(
    terminal ? ["orchestration:operate", "terminal:operate"] : [],
  );
});

it.each([undefined, "web", "mobile", "mcp"])("guards launch messages from %s", (creationSource) => {
  expect(
    clientRpcRequiredScopes(ORCHESTRATION_V2_WS_METHODS.launchThread, {
      creationSource,
      initialMessage: { text: "!ls" },
    }),
  ).toEqual(creationSource === "mcp" ? [] : ["orchestration:operate", "terminal:operate"]);
});
