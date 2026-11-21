import { lazy } from "react";

import type { ClientPluginSdk } from "../PluginHost";
import { declareBuiltinFeatures } from "../features";

declareBuiltinFeatures("t3.thread", [
  "chat.route",
  "chat.header",
  "chat.composer",
  "chat.canvas",
  "chat.timeline",
  "chat.details",
  "chat.terminal",
]);

export function activate(sdk: ClientPluginSdk) {
  sdk.register([
    {
      slot: "chat.route",
      order: -1000,
      component: lazy(() =>
        import("~/components/ThreadRouteView").then((module) => ({
          default: module.BuiltinThreadRouteView,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "chat.header",
      order: -1000,
      component: lazy(() =>
        import("~/components/chat/ChatHeader").then((module) => ({
          default: module.BuiltinChatHeader,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "chat.composer",
      order: -1000,
      component: lazy(() =>
        import("~/components/chat/ChatComposer").then((module) => ({
          default: module.BuiltinChatComposer,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "chat.canvas",
      order: -1000,
      component: lazy(() =>
        import("~/components/chat/ChatCanvas").then((module) => ({
          default: module.BuiltinChatCanvas,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "chat.timeline",
      order: -1000,
      component: lazy(() =>
        import("~/components/chat/MessagesTimeline").then((module) => ({
          default: module.BuiltinMessagesTimeline,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "chat.details",
      order: -1000,
      component: lazy(() =>
        import("~/components/chat/ThreadDetailsPanel").then((module) => ({
          default: module.BuiltinThreadDetailsPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "chat.terminal",
      order: -1000,
      component: lazy(() =>
        import("~/components/PersistentThreadTerminals").then((module) => ({
          default: module.BuiltinPersistentThreadTerminalPanel,
        })),
      ),
    },
  ]);
}
