import { PluginSetEnabledInput, PluginReloadInput, PluginInvokeInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DesktopIpc } from "../ipc/DesktopIpc.ts";
import { DesktopPluginRuntime } from "./DesktopPluginRuntime.ts";

const decodeReload = Schema.decodeUnknownEffect(PluginReloadInput);
const decodeSetEnabled = Schema.decodeUnknownEffect(PluginSetEnabledInput);
const decodeInvoke = Schema.decodeUnknownEffect(PluginInvokeInput);

/** Management endpoints stay reachable when a contributed desktop service fails. */
export const installDesktopPluginIpc = Effect.gen(function* () {
  const ipc = yield* DesktopIpc;
  const plugins = yield* DesktopPluginRuntime;
  yield* ipc.handle({ channel: "desktop:plugins:list", handler: () => plugins.list });
  yield* ipc.handle({
    channel: "desktop:plugins:reload",
    handler: (raw) => decodeReload(raw ?? {}).pipe(Effect.flatMap(plugins.reload)),
  });
  yield* ipc.handle({
    channel: "desktop:plugins:set-enabled",
    handler: (raw) => decodeSetEnabled(raw).pipe(Effect.flatMap(plugins.setEnabled)),
  });
  yield* ipc.handle({
    channel: "desktop:plugins:invoke",
    handler: (raw) => decodeInvoke(raw).pipe(Effect.flatMap(plugins.invoke)),
  });
});
