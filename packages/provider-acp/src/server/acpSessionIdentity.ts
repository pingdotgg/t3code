// ACP session behaviour extracted from server/adapter.ts (sessionIdentity).

import { acpProviderItemNativeId } from "./acpThreadContext.ts";
import { type OrchestrationV2ProviderThread } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { AcpSessionCore } from "./acpSessionContext.ts";

export const createAcpSessionIdentity = Effect.fn("acpSession.sessionIdentity")(function* (ctx: AcpSessionCore) {
  const sessionScope = yield* Effect.scope;
  let itemIdentityVersion: 2 | undefined =
    ctx.input.initialProviderItemIdentityVersion ??
    (ctx.input.initialNativeThreadId === undefined ? 2 : undefined);
  const providerNativeId = (nativeId: string) =>
    acpProviderItemNativeId({
      instanceId: ctx.options.instanceId,
      itemIdentityVersion,
      nativeId,
    });
  const providerNodeId = (nativeItemId: string) =>
    ctx.idAllocator.derive.nodeFromProviderItem({
      driver: ctx.driver,
      nativeItemId: providerNativeId(nativeItemId),
    });
  const providerMessageId = (nativeItemId: string) =>
    ctx.idAllocator.derive.messageFromProviderItem({
      driver: ctx.driver,
      nativeItemId: providerNativeId(nativeItemId),
    });
  const providerTurnItemId = (nativeItemId: string) =>
    ctx.idAllocator.derive.turnItemFromProviderItem({
      driver: ctx.driver,
      nativeItemId: providerNativeId(nativeItemId),
    });
  const deriveProviderTurnId = (nativeTurnId: string) =>
    ctx.idAllocator.derive.providerTurn({
      driver: ctx.driver,
      nativeTurnId: providerNativeId(nativeTurnId),
    });
  const useProviderThreadIdentity = (thread: OrchestrationV2ProviderThread): void => {
    itemIdentityVersion = thread.nativeMetadata?.itemIdentityVersion;
  };
  return {
    sessionScope,
    providerNativeId,
    providerNodeId,
    providerMessageId,
    providerTurnItemId,
    deriveProviderTurnId,
    useProviderThreadIdentity,
    get itemIdentityVersion() {
      return itemIdentityVersion;
    },
    set itemIdentityVersion(value) {
      itemIdentityVersion = value;
    },
  };
});
