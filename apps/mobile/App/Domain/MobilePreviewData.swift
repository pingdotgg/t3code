import Foundation

enum MobilePreviewData {
    static let environments = [
        MobileEnvironment(
            id: "environment-preview",
            title: "Ronak's Mac",
            connectionSummary: MobileDesign.connectionSummary,
            isConnected: true
        ),
    ]

    static let projects = [
        MobileProject(
            id: "project-preview",
            title: "T3 Code",
            workspaceRoot: "/Users/ronakguliani/code/t3code"
        ),
    ]

    static let threads = [
        MobileThread(
            id: "thread-preview",
            projectID: "project-preview",
            title: "Mobile sync gateway",
            status: "Ready",
            latestSummary: "Versioned /mobile/v1 contract and fixtures are available."
        ),
    ]

    static let threadDetail = MobileThreadDetail(
        threadID: "thread-preview",
        title: "Mobile sync gateway",
        snapshotSequence: 3,
        messages: [
            MobileChatMessage(
                id: "message-preview-user",
                role: "user",
                text: "Summarize the mobile sync gateway status.",
                streaming: false,
                createdAt: "2026-05-10T00:00:00.000Z"
            ),
            MobileChatMessage(
                id: "message-preview-assistant",
                role: "assistant",
                text: "The iOS app can now render cached shell and thread projections, then reconcile them from the mobile gateway.",
                streaming: false,
                createdAt: "2026-05-10T00:00:01.000Z"
            ),
        ],
        activities: [
            MobileThreadActivity(
                id: "activity-preview",
                tone: "tool",
                kind: "sync",
                summary: "Loaded thread snapshot from /mobile/v1/ws",
                createdAt: "2026-05-10T00:00:02.000Z",
                requestID: nil,
                interactionKind: .generic
            ),
        ],
        proposedPlans: [
            MobileProposedPlan(
                id: "plan-preview",
                turnID: "turn-preview",
                markdown: "1. Keep mobile sync projection-driven.\n2. Add interactive chat.\n3. Render diffs and checkpoints.",
                implementedAt: nil,
                createdAt: "2026-05-10T00:00:03.000Z"
            ),
        ],
        checkpoints: [
            MobileCheckpointSummary(
                id: "turn-preview:1",
                turnID: "turn-preview",
                turnCount: 1,
                status: "Ready",
                completedAt: "2026-05-10T00:00:04.000Z",
                files: [
                    MobileCheckpointFile(path: "apps/mobile/App/T3MobileApp.swift", additions: 12, deletions: 2),
                ]
            ),
        ],
        timelineItems: [],
        sessionStatus: "Ready",
        activeTurnID: nil
    )
}
