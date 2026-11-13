/**
 * Surfaces OpenCode 2 permission and form requests as T3 runtime requests.
 */
import {
  Form,
  Permission,
  Session,
} from "@opencode/client/effect";
import type { OrchestrationV2ExecutionNode, OrchestrationV2RuntimeRequest, OrchestrationV2TurnItem, OrchestrationV2UserInputQuestion } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { openCodePermissionRequestKind } from "../../adapter.ts";
import {
  ACTIVE_CHECK_TIMEOUT,
  REQUEST_REPLY_TIMEOUT,
  deliver,
  formGone,
  formQuestions,
  permissionGone,
  ref,
  sessionGrantLabel,
} from "./protocol.ts";
import type { NativeForm, PendingRequest, ThreadState } from "./types.ts";
import type { Turns } from "./turns.ts";
import type { Config } from "./config.ts";
import type { Projections } from "./projections.ts";
import type { State } from "./state.ts";

export const makeRequests = (
  deps: State & Projections & Config & Turns,
) => {
  const {
    driver,
    emit,
    finishTurn,
    idAllocator,
    input,
    live,
    markUnsettled,
    ordinalOf,
    ownerOf,
    pending,
    requestTurn,
    setSessionStatus,
    strays,
    threads,
  } = deps;

  const abandonRequest = Effect.fnUntraced(function* (state: ThreadState, reason: string) {
    yield* Effect.logWarning("Could not answer an OpenCode request; ending its turn.", {
      reason,
    });
    if (state.active === undefined) return;
    markUnsettled(state);
    yield* finishTurn(state, {
      status: "failed",
      failure: makeProviderFailure({
        message: "OpenCode is waiting on a request T3 Code couldn't answer.",
        class: "provider_error",
      }),
    });
    yield* live.client.session
      .interrupt({ sessionID: Session.ID.make(state.sessionId) })
      .pipe(Effect.timeout("2 seconds"), Effect.ignore({ log: true }));
  });

  const stopStaleRequest = (
    sessionId: string,
    native: { readonly type: "permission" | "form"; readonly id: string },
  ): Effect.Effect<void> =>
    native.type === "permission"
      ? live.client.permission
          .reply({
            sessionID: Session.ID.make(sessionId),
            requestID: Permission.ID.make(native.id),
            decision: "reject",
          })
          .pipe(
            Effect.catchTags(permissionGone),
            Effect.timeout(REQUEST_REPLY_TIMEOUT),
            Effect.ignore({ log: true }),
          )
      : live.client.session.form
          .cancel({ sessionID: sessionId, formID: Form.ID.make(native.id) })
          .pipe(
            Effect.catchTags(formGone),
            Effect.timeout(REQUEST_REPLY_TIMEOUT),
            Effect.ignore({ log: true }),
          );

  // T3 expired pre-load requests and no longer shows them; stop them so OpenCode cannot wait forever.
  const stopLeftoverRequests = Effect.fnUntraced(function* (state: ThreadState) {
    const sessionID = Session.ID.make(state.sessionId);
    const listed = yield* Effect.all([
      live.client.permission.list({ sessionID }),
      live.client.session.form.list({ sessionID }),
    ]).pipe(Effect.timeout(ACTIVE_CHECK_TIMEOUT), Effect.option);
    if (listed._tag === "None") {
      return yield* Effect.logWarning("Could not list an OpenCode session's open requests.");
    }
    const [permissions, forms] = listed.value;
    if (permissions.length === 0 && forms.length === 0) return;
    markUnsettled(state);
    for (const request of permissions) {
      yield* stopStaleRequest(state.sessionId, { type: "permission", id: request.id });
    }
    for (const form of forms) {
      yield* stopStaleRequest(state.sessionId, { type: "form", id: form.id });
    }
  });

  const showRequest = Effect.fnUntraced(function* (
    sessionId: string,
    native: PendingRequest["native"],
    body:
      | {
          readonly type: "approval_request";
          readonly requestKind: Extract<
            OrchestrationV2TurnItem,
            { type: "approval_request" }
          >["requestKind"];
          readonly prompt: string;
          readonly options: Extract<
            OrchestrationV2TurnItem,
            { type: "approval_request" }
          >["options"];
        }
      | {
          readonly type: "user_input_request";
          readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
        },
  ) {
    const target = requestTurn(sessionId);
    if (target === undefined) return;
    const { state, turn } = target;
    if ([...pending.values()].some((entry) => entry.native.id === native.id)) return;
    const now = yield* DateTime.now;
    const requestId = yield* idAllocator.allocate.runtimeRequest({
      driver,
      providerTurnId: turn.providerTurn.id,
      nativeRequestId: native.id,
    });
    const nodeId = idAllocator.derive.approvalNode({ requestId });
    const request: OrchestrationV2RuntimeRequest = {
      id: requestId,
      nodeId,
      providerTurnId: turn.providerTurn.id,
      nativeRequestRef: ref(native.id),
      kind: body.type === "approval_request" ? body.requestKind : "user_input",
      status: "pending",
      responseCapability: { type: "live", providerSessionId: input.providerSessionId },
      createdAt: now,
      resolvedAt: null,
    };
    const node: OrchestrationV2ExecutionNode = {
      id: nodeId,
      threadId: turn.input.threadId,
      runId: turn.input.runId,
      parentNodeId: turn.input.rootNodeId,
      rootNodeId: turn.input.rootNodeId,
      kind: body.type,
      status: "waiting",
      countsForRun: false,
      providerThreadId: state.providerThread.id,
      providerTurnId: turn.providerTurn.id,
      nativeItemRef: ref(native.id),
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };
    const base = {
      id: idAllocator.derive.approvalTurnItem({ requestId }),
      threadId: turn.input.threadId,
      runId: turn.input.runId,
      nodeId,
      providerThreadId: state.providerThread.id,
      providerTurnId: turn.providerTurn.id,
      nativeItemRef: ref(native.id),
      parentItemId: null,
      ordinal: ordinalOf(turn, native.id),
      status: "waiting" as const,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };
    const item: OrchestrationV2TurnItem =
      body.type === "approval_request"
        ? {
            ...base,
            title: native.type === "permission" ? native.action : null,
            type: "approval_request",
            requestId,
            requestKind: body.requestKind,
            prompt: body.prompt,
            ...(body.options === undefined ? {} : { options: body.options }),
          }
        : {
            ...base,
            title: "User input",
            type: "user_input_request",
            requestId,
            questions: body.questions,
          };
    pending.set(requestId, {
      request,
      item,
      node,
      state,
      turn,
      sessionId,
      answering: false,
      native,
    });
    yield* emit({ type: "node.updated", driver, node });
    yield* emit({
      type: "runtime_request.updated",
      driver,
      threadId: turn.input.threadId,
      runtimeRequest: request,
    });
    yield* emit({ type: "turn_item.updated", driver, turnItem: item });
    yield* setSessionStatus("waiting", null);
  });

  const onPermissionAsked = Effect.fnUntraced(function* (data: Permission.Request) {
    const turn = threads.get(data.sessionID)?.active;
    const toolName =
      data.source === undefined ? undefined : turn?.tools.get(data.source.id)?.name;
    const save = data.save ?? [];
    yield* showRequest(
      data.sessionID,
      { type: "permission", id: data.id, action: data.action, resources: data.resources, save },
      {
        type: "approval_request",
        requestKind: openCodePermissionRequestKind(data.action, toolName),
        prompt: data.resources.length === 0 ? data.action : data.resources.join("\n"),
        options: [
          { decision: "cancel", label: "Cancel" },
          { decision: "decline", label: "Decline" },
          ...(save.length > 0
            ? [
                {
                  decision: "acceptForSession" as const,
                  label: sessionGrantLabel(data.action, save),
                },
              ]
            : []),
          { decision: "accept", label: "Approve" },
        ],
      },
    );
  });

  const onFormCreated = Effect.fnUntraced(function* (form: NativeForm) {
    const target = requestTurn(form.sessionID);
    if (target === undefined) return;
    const { state } = target;
    const mapped = formQuestions(form);
    if ("questions" in mapped) {
      return yield* showRequest(
        form.sessionID,
        { type: "form", id: form.id, form },
        { type: "user_input_request", questions: mapped.questions },
      );
    }
    // Cancel reports user Stop; record failure here and skip that execution end.
    yield* Effect.logWarning("Declined an OpenCode form T3 Code cannot show.", {
      reason: mapped.unsupported,
    });
    const cancelled = yield* deliver(
      live.client.session.form.cancel({ sessionID: form.sessionID, formID: form.id }),
    );
    // Cancel stops the asking child's session, not its parent; child sessions have no Stop end to skip.
    const asker = threads.get(form.sessionID) ?? state;
    if (!cancelled) return yield* abandonRequest(asker, "form cancel failed");
    if (asker.subagent === undefined) markUnsettled(asker);
    yield* finishTurn(asker, {
      status: "failed",
      failure: makeProviderFailure({
        message: `OpenCode asked for ${mapped.unsupported}, which T3 Code can't show. The question was declined.`,
        class: "provider_error",
      }),
    });
  });

  const onAsked = Effect.fnUntraced(function* (
    asked:
      | { readonly type: "permission"; readonly request: Permission.Request }
      | { readonly type: "form"; readonly form: NativeForm },
  ) {
    const asking = asked.type === "permission" ? asked.request.sessionID : asked.form.sessionID;
    if (strays.has(asking)) {
      return yield* stopStaleRequest(
        asking,
        asked.type === "permission"
          ? { type: "permission", id: asked.request.id }
          : { type: "form", id: asked.form.id },
      );
    }
    const state = ownerOf(asking);
    if (state === undefined) return;
    const target = requestTurn(asking);
    if (target !== undefined && !target.turn.awaitingStart) {
      if (asked.type === "permission") return yield* onPermissionAsked(asked.request);
      return yield* onFormCreated(asked.form);
    }
    if (state.unsettled || state.active?.awaitingStart === true) {
      yield* stopStaleRequest(
        asking,
        asked.type === "permission"
          ? { type: "permission", id: asked.request.id }
          : { type: "form", id: asked.form.id },
      );
    }
  });

  return {
    abandonRequest,
    stopStaleRequest,
    stopLeftoverRequests,
    showRequest,
    onPermissionAsked,
    onFormCreated,
    onAsked,
  };
};

export type Requests = ReturnType<typeof makeRequests>;
