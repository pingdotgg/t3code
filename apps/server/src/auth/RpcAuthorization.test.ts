import {
  AuthAccessWriteScope, // fork: f1 provider account sign-in
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { RPC_REQUIRED_SCOPES, requiredScopeForRpcMethod } from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
  });

  // fork: f5 — these actions configure and operate the Claude/Codex provider
  // bridge. They belong to normal orchestration rather than T3 access control,
  // while observing the bridge status remains available to read-only clients.
  it("authorizes Claude/Codex bridge actions as provider operations", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.claudeCodexBridgeGetStatus)).toBe(
      AuthOrchestrationReadScope,
    );
    for (const method of [
      WS_METHODS.claudeCodexBridgeInstall,
      WS_METHODS.claudeCodexBridgeStartSignIn,
      WS_METHODS.claudeCodexBridgeSignOut,
      WS_METHODS.claudeCodexBridgeGetModels,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
      expect(requiredScopeForRpcMethod(method)).not.toBe(AuthAccessWriteScope);
    }
  });

  // fork: f1 — signing in/out mutates provider credentials, so it is gated on
  // access:write rather than orchestration:operate. A read-only paired client
  // must not be able to log the host out.
  it("requires access:write to sign a provider account in or out", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.providerStartSignIn)).toBe(AuthAccessWriteScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.providerSignOut)).toBe(AuthAccessWriteScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.providerStartSignIn)).not.toBe(
      AuthOrchestrationOperateScope,
    );
  });

  // fork: f4 — the source-control panel. The split is the whole reason a
  // read-only paired client is safe to hand the panel: it can look at the
  // working copy but cannot change it.
  it("lets a read-only client read the working copy", () => {
    for (const method of [
      WS_METHODS.workingCopyStatus,
      WS_METHODS.workingCopyDiff,
      WS_METHODS.workingCopyFileAtRef,
      WS_METHODS.workingCopyLog,
      WS_METHODS.workingCopyCommitDetail,
      WS_METHODS.workingCopyCommitFileDiff,
      WS_METHODS.workingCopyStashList,
      WS_METHODS.workingCopyListDiscardBackups,
      WS_METHODS.workingCopyLastCommitMessage,
      // fork: f4 AI commit message — reads the staged diff and returns text.
      WS_METHODS.workingCopyGenerateCommitMessage,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
  });

  it("requires orchestration:operate for everything that touches the index, tree, refs or stash", () => {
    for (const method of [
      WS_METHODS.workingCopyStagePaths,
      WS_METHODS.workingCopyUnstagePaths,
      WS_METHODS.workingCopyApplyPatch,
      WS_METHODS.workingCopyDiscardPaths,
      WS_METHODS.workingCopyRestoreDiscardBackup,
      WS_METHODS.workingCopyCommitStaged,
      WS_METHODS.workingCopyAmendCommit,
      WS_METHODS.workingCopyUndoLastCommit,
      WS_METHODS.workingCopyStashPush,
      WS_METHODS.workingCopyStashApply,
      WS_METHODS.workingCopyStashPop,
      WS_METHODS.workingCopyStashDrop,
      WS_METHODS.workingCopyResolveConflict,
      WS_METHODS.workingCopyAbortOperation,
      WS_METHODS.workingCopyCherryPick,
      WS_METHODS.workingCopyRevertCommit,
      WS_METHODS.workingCopyCheckoutCommit,
      WS_METHODS.workingCopyResetToCommit,
      WS_METHODS.workingCopyTagCommit,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
      expect(requiredScopeForRpcMethod(method)).not.toBe(AuthOrchestrationReadScope);
    }
  });

  it("reads the reviewer menu under the same scope as the pull request it belongs to", () => {
    // The candidate list is a read like the detail beside it, and asking somebody for a review is
    // a write like every other pull request operation.
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsReviewerCandidates)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsDetail),
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsRequestReviewers)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsComment),
    );
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});
