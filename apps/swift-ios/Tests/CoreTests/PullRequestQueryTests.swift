import Testing
@testable import T3Code

struct PullRequestQueryTests {
    @Test func unicodeLabelsFitUTF16LimitsAndStayTrimmed() {
        let label = "area:" + String(repeating: "😀", count: 200)
        #expect(PullRequestQuery(label).filters.labels?.first?.first?.utf16.count ?? 0 <= 200)
        let long = "area:\"" + String(repeating: "a", count: 194) + " bbb\""
        #expect(PullRequestQuery(long).filters.labels?.first?.first?.hasSuffix(" ") == false)
    }

    @Test func emptyLabelsStayTextAndNamespacedLabelsFitTheContract() {
        #expect(PullRequestQuery("label:, size:,").text == "label:, size:,")
        #expect(PullRequestQuery("label:,").filters.labels == nil)
        let value = "size:" + String(repeating: "x", count: 240)
        #expect(PullRequestQuery(value).filters.labels == [[String(value.prefix(200))]])
    }

    @Test func typedFiltersAreRemovedFromFreeText() {
        let query = PullRequestQuery(#"fix crash author:theo label:bug,"needs review" -label:wip draft:false review:changes_requested status:failure"#)
        #expect(query.text == "fix crash")
        #expect(query.filters == PullRequestListFilters(draft: "hide", review: "changes-requested", checks: "failing",
            labels: [["bug", "needs review"]], excludedLabels: ["wip"], author: "theo"))
    }

    @Test func labelGroupsAndUnknownPrefixesMatchMobileSearch() {
        let query = PullRequestQuery(#"label:bug,crash label:ios area:mobile -area:desktop https://example.com"#)
        #expect(query.text == "https://example.com")
        #expect(query.filters.labels == [["bug", "crash"], ["ios"], ["area:mobile"]])
        #expect(query.filters.excludedLabels == ["area:desktop"])
    }

    @Test func invalidKnownQualifiersRemainSearchText() {
        let query = PullRequestQuery("draft:maybe -author:theo review:later checks:pending status:waiting label:")
        #expect(query.text == "draft:maybe -author:theo review:later checks:pending status:waiting label:")
        #expect(query.filters == PullRequestListFilters())
    }

    @Test func changingTheDraftMenuRemovesAllTypedDraftOverrides() {
        let query = #"fix draft:true label:"needs review" draft:false"#
        #expect(PullRequestQuery.settingDraft("only", in: query) == #"fix label:"needs review""#)
        #expect(PullRequestQuery.settingDraft("hide", in: query) == query)
        #expect(PullRequestQuery.settingDraft(nil, in: query) == #"fix label:"needs review""#)
    }

    @Test func namesAreBoundedBeforeSendingToTheServer() {
        let query = PullRequestQuery((0..<20).map { "label:\(String(repeating: "x", count: 250))\($0)" }.joined(separator: " "))
        #expect(query.filters.labels?.count == 10)
        #expect(query.filters.labels?.allSatisfy { $0.allSatisfy { $0.count <= 200 } } == true)
    }
}
