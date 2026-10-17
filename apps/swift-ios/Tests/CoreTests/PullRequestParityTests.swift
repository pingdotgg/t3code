import Foundation
import Testing
@testable import T3Code

@Suite("Pull request action and permission parity")
struct PullRequestParityTests {
    @Test func currentProviderActionValuesDecodeWithoutBreakingDetailReads() throws {
        let summary = try JSONValue.object([
            "host": .string("github.com"), "kind": .string("github"), "searchesOnHost": .bool(true),
            "projectCount": .number(1), "configured": .bool(true),
            "actions": .array([.string("delete-branch"), .string("revert"), .string("approve-workflows")]),
        ]).decode(PullRequestProviderSummary.self)
        #expect(summary.actions == [.deleteBranch, .revert, .approveWorkflows])
        #expect(try detail(capabilities: ["actions": .array([.string("delete-branch")])])
            .capabilities.actions == [.deleteBranch])
    }

    @Test func deleteBranchNeedsCompletedPRCapabilityAndViewerPermission() throws {
        for state in ["closed", "merged"] {
            #expect(try detail(["state": .string(state)], capabilities: ["deleteBranch": .bool(true)])
                .canPerform(.deleteBranch))
        }
        #expect(try !detail(capabilities: ["deleteBranch": .bool(true)]).canPerform(.deleteBranch))
        #expect(try !detail(["state": .string("merged")]).canPerform(.deleteBranch))
        #expect(try !detail(["state": .string("closed")], capabilities: ["deleteBranch": .bool(false)])
            .canPerform(.deleteBranch))
        #expect(try !detail(["state": .string("merged")], capabilities: ["deleteBranch": .bool(true)],
            permissions: ["actions": .array([])]).canPerform(.deleteBranch))
        #expect(try !detail(["state": .string("merged")], capabilities: [
            "deleteBranch": .bool(true), "actions": .array([]),
        ]).canPerform(.deleteBranch))
    }

    @Test func actionsRespectPRStateAndBothActionLists() throws {
        let open = try detail()
        #expect(open.canPerform(.merge))
        #expect(open.canPerform(.close))
        #expect(open.canPerform(.draft))
        #expect(!open.canPerform(.ready))
        #expect(!open.canPerform(.reopen))
        #expect(!open.canPerform(.revert))
        let draft = try detail(["isDraft": .bool(true)])
        #expect(!draft.canPerform(.merge))
        #expect(!draft.canPerform(.draft))
        #expect(draft.canPerform(.ready))
        #expect(try !detail(["mergeability": .string("conflicting")]).canPerform(.merge))
        #expect(try !detail(capabilities: ["mergeMethods": .array([])]).canPerform(.merge))
        #expect(try detail(["state": .string("closed")]).canPerform(.reopen))
        #expect(try detail(["state": .string("merged")]).canPerform(.revert))
        for state in ["closed", "merged"] {
            let completed = try detail(["state": .string(state)])
            for action in [PullRequestAction.merge, .close, .ready, .draft, .updateBranch, .enableAutoMerge] {
                #expect(!completed.canPerform(action))
            }
        }
        for action in PullRequestAction.allCases {
            #expect(try !detail(capabilities: ["actions": .array([])]).canPerform(action))
            #expect(try !detail(permissions: ["actions": .array([])]).canPerform(action))
        }
    }

    @Test func updateMethodsAreTheIntersectionAndSilenceDoesNotEnableAutoMerge() throws {
        let restricted = try detail(
            capabilities: ["updateMethods": .array([.string("merge"), .string("rebase")])],
            permissions: ["updateMethods": .array([.string("rebase")])]
        )
        #expect(restricted.availableUpdateMethods == [.rebase])
        #expect(restricted.canPerform(.updateBranch))
        #expect(try !detail(capabilities: ["updateMethods": .null]).canPerform(.updateBranch))
        #expect(try !detail(permissions: ["updateMethods": .null]).canPerform(.updateBranch))
        #expect(try !detail().canPerform(.enableAutoMerge))
        #expect(try !detail().canPerform(.disableAutoMerge))
        #expect(try detail(["autoMergeEnabled": .bool(false)]).canPerform(.enableAutoMerge))
        #expect(try detail(["autoMergeEnabled": .bool(true)]).canPerform(.disableAutoMerge))
        #expect(try !detail(["autoMergeEnabled": .bool(true)]).canPerform(.enableAutoMerge))
        #expect(try !detail().canPerform(.approveWorkflows))
        #expect(try detail(["workflowApprovalsRequired": .number(2)]).canPerform(.approveWorkflows))
    }

    @Test func editingUsesExplicitFlagsAndOlderV2AuthorFallback() throws {
        let author = try detail(permissions: ["actions": .array([])])
        #expect(author.canEditChangeRequest)
        #expect(try detail(["viewer": .string(" OCTOCAT ")], permissions: ["actions": .array([])])
            .canEditChangeRequest)
        #expect(try !detail(["viewer": .string("other")], permissions: ["actions": .array([])])
            .canEditChangeRequest)
        #expect(try detail(["viewer": .string("maintainer")]).canEditChangeRequest)
        #expect(try !detail(permissions: ["editChangeRequest": .bool(false)]).canEditChangeRequest)
        #expect(try detail(["viewer": .string("other")], permissions: [
            "actions": .array([]), "editChangeRequest": .bool(true),
        ]).canEditChangeRequest)
        #expect(try !detail(capabilities: ["edit": .object([
            "changeRequest": .bool(false), "comment": .bool(false),
        ])], permissions: ["editChangeRequest": .bool(true)]).canEditChangeRequest)

        var comment = try commentFields.decode(PullRequestComment.self)
        #expect(author.canEditComment(comment))
        comment.canEdit = false
        #expect(!author.canEditComment(comment))
        comment.canEdit = true
        #expect(try detail(["viewer": .string("other")]).canEditComment(comment))
        #expect(try !detail(capabilities: ["edit": .null]).canEditComment(comment))
        guard case .object(var fields) = commentFields else {
            Issue.record("Expected a comment object")
            return
        }
        fields["kind"] = .string("review")
        fields["canEdit"] = .bool(true)
        #expect(try !author.canEditComment(JSONValue.object(fields).decode(PullRequestComment.self)))
        var inline = try commentFields.decode(PullRequestThreadComment.self)
        #expect(author.canEditComment(inline))
        inline.canEdit = false
        #expect(!author.canEditComment(inline))
    }

    @Test func threadFlagOnlyNarrowsResolvePermission() throws {
        var thread = try JSONValue.object([
            "id": .string("thread"), "path": .string("App.swift"), "side": .string("right"),
            "isResolved": .bool(false), "isOutdated": .bool(false), "comments": .array([]),
        ]).decode(PullRequestReviewThread.self)
        #expect(thread.canResolve == nil)
        #expect(try detail().canResolveThread(thread))
        thread.canResolve = false
        #expect(try !detail().canResolveThread(thread))
        thread.canResolve = true
        #expect(try !detail(permissions: ["resolve": .bool(false)]).canResolveThread(thread))
        #expect(try !detail(capabilities: ["review": .object([
            "inlineComment": .bool(true), "reply": .bool(true), "resolve": .bool(false),
            "verdicts": .array([.string("comment")]),
        ])]).canResolveThread(thread))
    }

    @Test func olderV2OmittedFlagsSurviveDecodingAndCacheRoundTrip() throws {
        let older = try detail()
        #expect(older.capabilities.deleteBranch == nil)
        #expect(older.viewerPermissions.editChangeRequest == nil)
        #expect(older.workflowApprovalsRequired == nil)
        #expect(try JSONValue.encode(older).decode(PullRequestDetail.self) == older)
        let comment = try commentFields.decode(PullRequestComment.self)
        let inline = try commentFields.decode(PullRequestThreadComment.self)
        #expect(comment.canEdit == nil)
        #expect(inline.canEdit == nil)
        var updated = comment
        updated.canEdit = false
        #expect(updated != comment)
        #expect(try JSONValue.encode(updated).decode(PullRequestComment.self).canEdit == false)
        let summary = try JSONValue.object([
            "host": .string("github.com"), "kind": .string("github"), "searchesOnHost": .bool(true),
            "projectCount": .number(1), "configured": .bool(true),
        ]).decode(PullRequestProviderSummary.self)
        #expect(summary.actions == nil)
    }

    @Test func observedStateReportsKeepOriginIdentityAndRemoveRoutedReadGuards() throws {
        let reference = PullRequestRef(projectId: "origin-project", repository: "org/repo", number: 42,
            host: "github.enterprise.example", expectedAccountId: "alternate-account", allowStale: false)
        for state in PullRequestState.allCases {
            let payload = try JSONValue.encode(PullRequestReportStateInput(reference: reference, state: state))
            #expect(payload == .object([
                "reference": .object([
                    "projectId": .string("origin-project"), "repository": .string("org/repo"),
                    "number": .number(42), "host": .string("github.enterprise.example"),
                ]),
                "state": .string(state.rawValue),
            ]))
        }
    }

    private var commentFields: JSONValue {
        .object([
            "id": .string("comment"), "kind": .string("issue-comment"),
            "author": .object(["login": .string("octocat")]),
            "body": .string("Review"), "createdAt": .string("2026-10-16T00:00:00Z"),
        ])
    }

    private func detail(
        _ overrides: [String: JSONValue] = [:],
        capabilities capabilityOverrides: [String: JSONValue] = [:],
        permissions permissionOverrides: [String: JSONValue] = [:]
    ) throws -> PullRequestDetail {
        let actions = JSONValue.array(PullRequestAction.allCases.map { .string($0.rawValue) })
        let capabilities: [String: JSONValue] = [
            "diff": .bool(true), "comment": .bool(true), "actions": actions,
            "mergeMethods": .array([.string("merge")]), "updateMethods": .array([.string("merge")]),
            "search": .bool(true),
            "review": .object(["inlineComment": .bool(true), "reply": .bool(true), "resolve": .bool(true),
                "verdicts": .array([.string("comment")])]),
            "reviewers": .object(["request": .bool(true), "listCandidates": .bool(true)]),
            "edit": .object(["changeRequest": .bool(true), "comment": .bool(true)]),
        ]
        let permissions: [String: JSONValue] = [
            "actions": actions, "comment": .bool(true), "resolve": .bool(true),
            "verdicts": .array([.string("comment")]), "requestReviewers": .bool(true),
            "updateMethods": .array([.string("merge")]),
        ]
        let fields: [String: JSONValue] = [
            "provider": .string("github"),
            "capabilities": .object(capabilities.merging(capabilityOverrides) { _, value in value }),
            "viewerPermissions": .object(permissions.merging(permissionOverrides) { _, value in value }),
            "projectId": .string("project"), "projectTitle": .string("Project"), "workspaceRoot": .string("/repo"),
            "repository": .string("org/repo"), "number": .number(42), "title": .string("Fix"), "body": .string(""),
            "url": .string("https://github.com/org/repo/pull/42"), "author": .object(["login": .string("octocat")]),
            "state": .string("open"), "isDraft": .bool(false), "mergeability": .string("mergeable"),
            "additions": .number(1), "deletions": .number(0), "changedFiles": .number(1),
            "headBranch": .string("fix"), "baseBranch": .string("main"),
            "createdAt": .string("2026-10-16T00:00:00Z"), "updatedAt": .string("2026-10-16T00:00:00Z"),
            "reviewers": .array([]), "labels": .array([]), "checks": .array([]), "viewer": .string("octocat"),
            "mergeCapabilities": .object(["merge": .bool(true), "squash": .bool(false), "rebase": .bool(false)]),
        ]
        return try JSONValue.object(fields.merging(overrides) { _, value in value }).decode(PullRequestDetail.self)
    }
}
