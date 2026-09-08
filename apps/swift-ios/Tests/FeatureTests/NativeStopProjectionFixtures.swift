import Foundation
@testable import T3Code

// Captured from the b592 engine/projector with a held in-memory provider.
// Terminal phases are explicit resolution + ready-session commands, not live provider completion.
enum NativeStopProjectionFixtures {
    static func snapshot(_ scenario: String) throws -> JSONValue {
        try JSONDecoder.t3.decode(JSONValue.self, from: Data(captures[scenario]!.utf8))
    }

    private static let captures: [String: String] = [
        // Source capture SHA256: 409c2824312c4d9bb71400fdcdc3be67b3259169bf25a545a330a2e6047d6a8c
        "approval": #"""
        {
          "threadId": "thread-1",
          "before": {
            "shell": {
              "snapshotSequence": 4,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "running",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": null,
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:01.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "running",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": "outcome-proof-A",
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:00.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": true,
                  "hasPendingUserInput": false,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:01.000Z"
            },
            "detail": {
              "snapshotSequence": 4,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "running",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": null,
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:01.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [
                  {
                    "id": "outcome-proof-approval-activity",
                    "tone": "approval",
                    "kind": "approval.requested",
                    "summary": "Command approval requested",
                    "payload": {
                      "requestId": "outcome-proof-approval-1",
                      "requestKind": "command"
                    },
                    "turnId": "outcome-proof-A",
                    "createdAt": "2026-01-01T00:00:01.000Z"
                  }
                ],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "running",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": "outcome-proof-A",
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              }
            }
          },
          "requestHeld": {
            "shell": {
              "snapshotSequence": 5,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "interrupted",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": "2026-01-01T00:00:02.000Z",
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:01.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "running",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": "outcome-proof-A",
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:00.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": true,
                  "hasPendingUserInput": false,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:02.000Z"
            },
            "detail": {
              "snapshotSequence": 5,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "interrupted",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": "2026-01-01T00:00:02.000Z",
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:01.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [
                  {
                    "id": "outcome-proof-approval-activity",
                    "tone": "approval",
                    "kind": "approval.requested",
                    "summary": "Command approval requested",
                    "payload": {
                      "requestId": "outcome-proof-approval-1",
                      "requestKind": "command"
                    },
                    "turnId": "outcome-proof-A",
                    "createdAt": "2026-01-01T00:00:01.000Z"
                  }
                ],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "running",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": "outcome-proof-A",
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              }
            }
          },
          "afterAcknowledged": {
            "shell": {
              "snapshotSequence": 5,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "interrupted",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": "2026-01-01T00:00:02.000Z",
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:01.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "running",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": "outcome-proof-A",
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:00.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": true,
                  "hasPendingUserInput": false,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:02.000Z"
            },
            "detail": {
              "snapshotSequence": 5,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "interrupted",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": "2026-01-01T00:00:02.000Z",
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:01.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [
                  {
                    "id": "outcome-proof-approval-activity",
                    "tone": "approval",
                    "kind": "approval.requested",
                    "summary": "Command approval requested",
                    "payload": {
                      "requestId": "outcome-proof-approval-1",
                      "requestKind": "command"
                    },
                    "turnId": "outcome-proof-A",
                    "createdAt": "2026-01-01T00:00:01.000Z"
                  }
                ],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "running",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": "outcome-proof-A",
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              }
            }
          },
          "afterTerminal": {
            "shell": {
              "snapshotSequence": 7,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "interrupted",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": "2026-01-01T00:00:02.000Z",
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:03.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "ready",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": null,
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:03.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": false,
                  "hasPendingUserInput": false,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:03.000Z"
            },
            "detail": {
              "snapshotSequence": 7,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "interrupted",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": "2026-01-01T00:00:02.000Z",
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:03.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [
                  {
                    "id": "outcome-proof-approval-activity",
                    "tone": "approval",
                    "kind": "approval.requested",
                    "summary": "Command approval requested",
                    "payload": {
                      "requestId": "outcome-proof-approval-1",
                      "requestKind": "command"
                    },
                    "turnId": "outcome-proof-A",
                    "createdAt": "2026-01-01T00:00:01.000Z"
                  },
                  {
                    "id": "outcome-proof-resolved-activity",
                    "tone": "info",
                    "kind": "approval.resolved",
                    "summary": "Pending request resolved (fixture terminal command)",
                    "payload": {
                      "requestId": "outcome-proof-approval-1",
                      "decision": "cancel"
                    },
                    "turnId": "outcome-proof-A",
                    "createdAt": "2026-01-01T00:00:03.000Z"
                  }
                ],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "ready",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": null,
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:03.000Z"
                }
              }
            }
          }
        }
        """#,
        // Source capture SHA256: 6633d0a12343a5ac72daa0f6caa6fbc872a3208449329f80b7ca535d3f232cab
        "approval-starting": #"""
        {
          "threadId": "thread-1",
          "before": {
            "shell": {
              "snapshotSequence": 5,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "running",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": null,
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:01.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "starting",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": "outcome-proof-A",
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:01.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": true,
                  "hasPendingUserInput": false,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:01.000Z"
            },
            "detail": {
              "snapshotSequence": 5,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "running",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": null,
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:01.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [
                  {
                    "id": "outcome-proof-approval-activity",
                    "tone": "approval",
                    "kind": "approval.requested",
                    "summary": "Command approval requested",
                    "payload": {
                      "requestId": "outcome-proof-approval-1",
                      "requestKind": "command"
                    },
                    "turnId": "outcome-proof-A",
                    "createdAt": "2026-01-01T00:00:01.000Z"
                  }
                ],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "starting",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": "outcome-proof-A",
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:01.000Z"
                }
              }
            }
          },
          "requestHeld": {
            "shell": {
              "snapshotSequence": 6,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "interrupted",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": "2026-01-01T00:00:02.000Z",
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:01.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "starting",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": "outcome-proof-A",
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:01.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": true,
                  "hasPendingUserInput": false,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:02.000Z"
            },
            "detail": {
              "snapshotSequence": 6,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "interrupted",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": "2026-01-01T00:00:02.000Z",
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:01.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [
                  {
                    "id": "outcome-proof-approval-activity",
                    "tone": "approval",
                    "kind": "approval.requested",
                    "summary": "Command approval requested",
                    "payload": {
                      "requestId": "outcome-proof-approval-1",
                      "requestKind": "command"
                    },
                    "turnId": "outcome-proof-A",
                    "createdAt": "2026-01-01T00:00:01.000Z"
                  }
                ],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "starting",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": "outcome-proof-A",
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:01.000Z"
                }
              }
            }
          },
          "afterAcknowledged": {
            "shell": {
              "snapshotSequence": 6,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "interrupted",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": "2026-01-01T00:00:02.000Z",
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:01.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "starting",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": "outcome-proof-A",
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:01.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": true,
                  "hasPendingUserInput": false,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:02.000Z"
            },
            "detail": {
              "snapshotSequence": 6,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "interrupted",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": "2026-01-01T00:00:02.000Z",
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:01.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [
                  {
                    "id": "outcome-proof-approval-activity",
                    "tone": "approval",
                    "kind": "approval.requested",
                    "summary": "Command approval requested",
                    "payload": {
                      "requestId": "outcome-proof-approval-1",
                      "requestKind": "command"
                    },
                    "turnId": "outcome-proof-A",
                    "createdAt": "2026-01-01T00:00:01.000Z"
                  }
                ],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "starting",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": "outcome-proof-A",
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:01.000Z"
                }
              }
            }
          },
          "afterTerminal": {
            "shell": {
              "snapshotSequence": 8,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "interrupted",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": "2026-01-01T00:00:02.000Z",
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:03.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "ready",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": null,
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:03.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": false,
                  "hasPendingUserInput": false,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:03.000Z"
            },
            "detail": {
              "snapshotSequence": 8,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "interrupted",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": "2026-01-01T00:00:02.000Z",
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:03.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [
                  {
                    "id": "outcome-proof-approval-activity",
                    "tone": "approval",
                    "kind": "approval.requested",
                    "summary": "Command approval requested",
                    "payload": {
                      "requestId": "outcome-proof-approval-1",
                      "requestKind": "command"
                    },
                    "turnId": "outcome-proof-A",
                    "createdAt": "2026-01-01T00:00:01.000Z"
                  },
                  {
                    "id": "outcome-proof-resolved-activity",
                    "tone": "info",
                    "kind": "approval.resolved",
                    "summary": "Pending request resolved (fixture terminal command)",
                    "payload": {
                      "requestId": "outcome-proof-approval-1",
                      "decision": "cancel"
                    },
                    "turnId": "outcome-proof-A",
                    "createdAt": "2026-01-01T00:00:03.000Z"
                  }
                ],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "ready",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": null,
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:03.000Z"
                }
              }
            }
          }
        }
        """#,
        // Source capture SHA256: 627f5b3e790c48b03a849b152d658430ee77f79049c2b3a02a4e8f67d0095098
        "input": #"""
        {
          "threadId": "thread-1",
          "before": {
            "shell": {
              "snapshotSequence": 4,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "running",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": null,
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:01.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "running",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": "outcome-proof-A",
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:00.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": false,
                  "hasPendingUserInput": true,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:01.000Z"
            },
            "detail": {
              "snapshotSequence": 4,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "running",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": null,
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:01.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [
                  {
                    "id": "outcome-proof-input-activity",
                    "tone": "info",
                    "kind": "user-input.requested",
                    "summary": "User input requested",
                    "payload": {
                      "requestId": "outcome-proof-input-1",
                      "questions": [
                        {
                          "id": "sandbox_mode",
                          "header": "Sandbox",
                          "question": "Which mode should be used?",
                          "options": [
                            {
                              "label": "workspace-write",
                              "description": "Allow workspace writes only"
                            }
                          ]
                        }
                      ]
                    },
                    "turnId": "outcome-proof-A",
                    "createdAt": "2026-01-01T00:00:01.000Z"
                  }
                ],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "running",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": "outcome-proof-A",
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              }
            }
          },
          "requestHeld": {
            "shell": {
              "snapshotSequence": 5,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "interrupted",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": "2026-01-01T00:00:02.000Z",
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:01.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "running",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": "outcome-proof-A",
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:00.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": false,
                  "hasPendingUserInput": true,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:02.000Z"
            },
            "detail": {
              "snapshotSequence": 5,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "interrupted",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": "2026-01-01T00:00:02.000Z",
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:01.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [
                  {
                    "id": "outcome-proof-input-activity",
                    "tone": "info",
                    "kind": "user-input.requested",
                    "summary": "User input requested",
                    "payload": {
                      "requestId": "outcome-proof-input-1",
                      "questions": [
                        {
                          "id": "sandbox_mode",
                          "header": "Sandbox",
                          "question": "Which mode should be used?",
                          "options": [
                            {
                              "label": "workspace-write",
                              "description": "Allow workspace writes only"
                            }
                          ]
                        }
                      ]
                    },
                    "turnId": "outcome-proof-A",
                    "createdAt": "2026-01-01T00:00:01.000Z"
                  }
                ],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "running",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": "outcome-proof-A",
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              }
            }
          },
          "afterAcknowledged": {
            "shell": {
              "snapshotSequence": 5,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "interrupted",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": "2026-01-01T00:00:02.000Z",
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:01.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "running",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": "outcome-proof-A",
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:00.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": false,
                  "hasPendingUserInput": true,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:02.000Z"
            },
            "detail": {
              "snapshotSequence": 5,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "interrupted",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": "2026-01-01T00:00:02.000Z",
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:01.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [
                  {
                    "id": "outcome-proof-input-activity",
                    "tone": "info",
                    "kind": "user-input.requested",
                    "summary": "User input requested",
                    "payload": {
                      "requestId": "outcome-proof-input-1",
                      "questions": [
                        {
                          "id": "sandbox_mode",
                          "header": "Sandbox",
                          "question": "Which mode should be used?",
                          "options": [
                            {
                              "label": "workspace-write",
                              "description": "Allow workspace writes only"
                            }
                          ]
                        }
                      ]
                    },
                    "turnId": "outcome-proof-A",
                    "createdAt": "2026-01-01T00:00:01.000Z"
                  }
                ],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "running",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": "outcome-proof-A",
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              }
            }
          },
          "afterTerminal": {
            "shell": {
              "snapshotSequence": 7,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "interrupted",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": "2026-01-01T00:00:02.000Z",
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:03.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "ready",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": null,
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:03.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": false,
                  "hasPendingUserInput": false,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:03.000Z"
            },
            "detail": {
              "snapshotSequence": 7,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "interrupted",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": "2026-01-01T00:00:02.000Z",
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:03.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [
                  {
                    "id": "outcome-proof-input-activity",
                    "tone": "info",
                    "kind": "user-input.requested",
                    "summary": "User input requested",
                    "payload": {
                      "requestId": "outcome-proof-input-1",
                      "questions": [
                        {
                          "id": "sandbox_mode",
                          "header": "Sandbox",
                          "question": "Which mode should be used?",
                          "options": [
                            {
                              "label": "workspace-write",
                              "description": "Allow workspace writes only"
                            }
                          ]
                        }
                      ]
                    },
                    "turnId": "outcome-proof-A",
                    "createdAt": "2026-01-01T00:00:01.000Z"
                  },
                  {
                    "id": "outcome-proof-resolved-activity",
                    "tone": "info",
                    "kind": "user-input.resolved",
                    "summary": "Pending request resolved (fixture terminal command)",
                    "payload": {
                      "requestId": "outcome-proof-input-1",
                      "decision": "cancel"
                    },
                    "turnId": "outcome-proof-A",
                    "createdAt": "2026-01-01T00:00:03.000Z"
                  }
                ],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "ready",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": null,
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:03.000Z"
                }
              }
            }
          }
        }
        """#,
        // Source capture SHA256: 699096e61aa6bfc392a77ea33d1915f2c64f3bb1041197d0e5c85ab909ea63da
        "background-ready-null": #"""
        {
          "threadId": "thread-1",
          "before": {
            "shell": {
              "snapshotSequence": 4,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "completed",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": "2026-01-01T00:00:01.000Z",
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:01.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "ready",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": null,
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:01.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": false,
                  "hasPendingUserInput": false,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:01.000Z"
            },
            "detail": {
              "snapshotSequence": 4,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "completed",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": "2026-01-01T00:00:01.000Z",
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:01.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "ready",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": null,
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:01.000Z"
                }
              }
            }
          },
          "requestHeld": {
            "shell": {
              "snapshotSequence": 5,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "interrupted",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": "2026-01-01T00:00:01.000Z",
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:01.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "ready",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": null,
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:01.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": false,
                  "hasPendingUserInput": false,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:02.000Z"
            },
            "detail": {
              "snapshotSequence": 5,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "interrupted",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": "2026-01-01T00:00:01.000Z",
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:01.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "ready",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": null,
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:01.000Z"
                }
              }
            }
          },
          "afterAcknowledged": {
            "shell": {
              "snapshotSequence": 5,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "interrupted",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": "2026-01-01T00:00:01.000Z",
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:01.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "ready",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": null,
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:01.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": false,
                  "hasPendingUserInput": false,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:02.000Z"
            },
            "detail": {
              "snapshotSequence": 5,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "interrupted",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": "2026-01-01T00:00:01.000Z",
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:01.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "ready",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": null,
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:01.000Z"
                }
              }
            }
          },
          "afterTerminal": {
            "shell": {
              "snapshotSequence": 6,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "interrupted",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": "2026-01-01T00:00:01.000Z",
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:03.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "ready",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": null,
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:03.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": false,
                  "hasPendingUserInput": false,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:03.000Z"
            },
            "detail": {
              "snapshotSequence": 6,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "interrupted",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": "2026-01-01T00:00:01.000Z",
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:03.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "ready",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": null,
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:03.000Z"
                }
              }
            }
          }
        }
        """#,
        // Source capture SHA256: 2068406d2ec5e566c4bb64000e394c9d27e1f8c9533e35a992ae63ff18a4d559
        "active-running-null": #"""
        {
          "threadId": "thread-1",
          "before": {
            "shell": {
              "snapshotSequence": 4,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "running",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": null,
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:01.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "running",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": null,
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:01.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": false,
                  "hasPendingUserInput": false,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:01.000Z"
            },
            "detail": {
              "snapshotSequence": 4,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "running",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": null,
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:01.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "running",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": null,
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:01.000Z"
                }
              }
            }
          },
          "requestHeld": {
            "shell": {
              "snapshotSequence": 5,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "interrupted",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": "2026-01-01T00:00:02.000Z",
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:01.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "running",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": null,
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:01.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": false,
                  "hasPendingUserInput": false,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:02.000Z"
            },
            "detail": {
              "snapshotSequence": 5,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "interrupted",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": "2026-01-01T00:00:02.000Z",
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:01.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "running",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": null,
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:01.000Z"
                }
              }
            }
          },
          "afterAcknowledged": {
            "shell": {
              "snapshotSequence": 5,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "interrupted",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": "2026-01-01T00:00:02.000Z",
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:01.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "running",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": null,
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:01.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": false,
                  "hasPendingUserInput": false,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:02.000Z"
            },
            "detail": {
              "snapshotSequence": 5,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "interrupted",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": "2026-01-01T00:00:02.000Z",
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:01.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "running",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": null,
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:01.000Z"
                }
              }
            }
          },
          "afterTerminal": {
            "shell": {
              "snapshotSequence": 6,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "interrupted",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": "2026-01-01T00:00:02.000Z",
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:03.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "ready",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": null,
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:03.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": false,
                  "hasPendingUserInput": false,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:03.000Z"
            },
            "detail": {
              "snapshotSequence": 6,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "interrupted",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": "2026-01-01T00:00:02.000Z",
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:03.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "ready",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": null,
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:03.000Z"
                }
              }
            }
          }
        }
        """#,
        // Source capture SHA256: ed3d66ad519f7b40052e722c8a00d5a9b5815c78c99714abe28ffc9e192d0183
        "input-failure": #"""
        {
          "threadId": "thread-1",
          "before": {
            "shell": {
              "snapshotSequence": 4,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "running",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": null,
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:01.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "running",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": "outcome-proof-A",
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:00.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": false,
                  "hasPendingUserInput": true,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:01.000Z"
            },
            "detail": {
              "snapshotSequence": 4,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "running",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": null,
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:01.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [
                  {
                    "id": "outcome-proof-input-activity",
                    "tone": "info",
                    "kind": "user-input.requested",
                    "summary": "User input requested",
                    "payload": {
                      "requestId": "outcome-proof-input-1",
                      "questions": [
                        {
                          "id": "sandbox_mode",
                          "header": "Sandbox",
                          "question": "Which mode should be used?",
                          "options": [
                            {
                              "label": "workspace-write",
                              "description": "Allow workspace writes only"
                            }
                          ]
                        }
                      ]
                    },
                    "turnId": "outcome-proof-A",
                    "createdAt": "2026-01-01T00:00:01.000Z"
                  }
                ],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "running",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": "outcome-proof-A",
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              }
            }
          },
          "requestHeld": {
            "shell": {
              "snapshotSequence": 5,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "interrupted",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": "2026-01-01T00:00:02.000Z",
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:01.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "running",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": "outcome-proof-A",
                    "lastError": null,
                    "updatedAt": "2026-01-01T00:00:00.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": false,
                  "hasPendingUserInput": true,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:02.000Z"
            },
            "detail": {
              "snapshotSequence": 5,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "interrupted",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": "2026-01-01T00:00:02.000Z",
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:01.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [
                  {
                    "id": "outcome-proof-input-activity",
                    "tone": "info",
                    "kind": "user-input.requested",
                    "summary": "User input requested",
                    "payload": {
                      "requestId": "outcome-proof-input-1",
                      "questions": [
                        {
                          "id": "sandbox_mode",
                          "header": "Sandbox",
                          "question": "Which mode should be used?",
                          "options": [
                            {
                              "label": "workspace-write",
                              "description": "Allow workspace writes only"
                            }
                          ]
                        }
                      ]
                    },
                    "turnId": "outcome-proof-A",
                    "createdAt": "2026-01-01T00:00:01.000Z"
                  }
                ],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "running",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": "outcome-proof-A",
                  "lastError": null,
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              }
            }
          },
          "afterFailure": {
            "shell": {
              "snapshotSequence": 7,
              "projects": [
                {
                  "id": "project-1",
                  "title": "Provider Project",
                  "workspaceRoot": "/tmp/provider-project",
                  "repositoryIdentity": null,
                  "defaultModelSelection": null,
                  "defaultThreadEnvMode": null,
                  "autoPull": false,
                  "faviconPath": null,
                  "projectIcon": null,
                  "scripts": [],
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:00.000Z"
                }
              ],
              "threads": [
                {
                  "id": "thread-1",
                  "projectId": "project-1",
                  "title": "Thread",
                  "modelSelection": {
                    "instanceId": "codex",
                    "model": "gpt-5-codex"
                  },
                  "runtimeMode": "approval-required",
                  "interactionMode": "default",
                  "branch": null,
                  "worktreePath": null,
                  "branchPullRequest": null,
                  "latestTurn": {
                    "turnId": "outcome-proof-A",
                    "state": "interrupted",
                    "requestedAt": "2026-01-01T00:00:00.000Z",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "completedAt": "2026-01-01T00:00:02.000Z",
                    "assistantMessageId": null
                  },
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-01T00:00:02.000Z",
                  "archivedAt": null,
                  "settledOverride": null,
                  "settledAt": null,
                  "unsettledAt": null,
                  "snoozedUntil": null,
                  "snoozedAt": null,
                  "pinnedAt": null,
                  "pinOrderKey": null,
                  "activeOrderKey": null,
                  "titleRegeneration": null,
                  "session": {
                    "threadId": "thread-1",
                    "status": "stopped",
                    "providerName": "codex",
                    "runtimeMode": "approval-required",
                    "activeTurnId": null,
                    "lastError": "Held fixture provider interrupt failed (stub)",
                    "updatedAt": "2026-01-01T00:00:02.000Z"
                  },
                  "latestUserMessageAt": null,
                  "hasPendingApprovals": false,
                  "hasPendingUserInput": true,
                  "hasActionableProposedPlan": false,
                  "backgroundLiveness": null,
                  "planProgress": null
                }
              ],
              "updatedAt": "2026-01-01T00:00:02.000Z"
            },
            "detail": {
              "snapshotSequence": 7,
              "thread": {
                "id": "thread-1",
                "projectId": "project-1",
                "title": "Thread",
                "modelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5-codex"
                },
                "runtimeMode": "approval-required",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "branchPullRequest": null,
                "latestTurn": {
                  "turnId": "outcome-proof-A",
                  "state": "interrupted",
                  "requestedAt": "2026-01-01T00:00:00.000Z",
                  "startedAt": "2026-01-01T00:00:00.000Z",
                  "completedAt": "2026-01-01T00:00:02.000Z",
                  "assistantMessageId": null
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:02.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "unsettledAt": null,
                "snoozedUntil": null,
                "snoozedAt": null,
                "pinnedAt": null,
                "pinOrderKey": null,
                "activeOrderKey": null,
                "titleRegeneration": null,
                "deletedAt": null,
                "messages": [],
                "proposedPlans": [],
                "activities": [
                  {
                    "id": "outcome-proof-input-activity",
                    "tone": "info",
                    "kind": "user-input.requested",
                    "summary": "User input requested",
                    "payload": {
                      "requestId": "outcome-proof-input-1",
                      "questions": [
                        {
                          "id": "sandbox_mode",
                          "header": "Sandbox",
                          "question": "Which mode should be used?",
                          "options": [
                            {
                              "label": "workspace-write",
                              "description": "Allow workspace writes only"
                            }
                          ]
                        }
                      ]
                    },
                    "turnId": "outcome-proof-A",
                    "createdAt": "2026-01-01T00:00:01.000Z"
                  },
                  {
                    "id": "8853c32a-affd-4ce5-97ea-39b0b71e024d",
                    "tone": "error",
                    "kind": "provider.turn.interrupt.failed",
                    "summary": "Provider turn interrupt failed",
                    "payload": {
                      "detail": "Held fixture provider interrupt failed (stub)"
                    },
                    "turnId": "outcome-proof-A",
                    "createdAt": "2026-01-01T00:00:02.000Z"
                  }
                ],
                "checkpoints": [],
                "session": {
                  "threadId": "thread-1",
                  "status": "stopped",
                  "providerName": "codex",
                  "runtimeMode": "approval-required",
                  "activeTurnId": null,
                  "lastError": "Held fixture provider interrupt failed (stub)",
                  "updatedAt": "2026-01-01T00:00:02.000Z"
                }
              }
            }
          }
        }
        """#,
    ]
}
