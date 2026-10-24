import Foundation
import Testing
@testable import T3Code

@Suite("Assistant citation previews")
struct AssistantCitationTextTests {
    @Test func expandsQuotesAndCommentsWithoutChangingMalformedLinks() {
        let link = "[Assistant quote](t3-citation://v1/env/thread/message?text=Quoted%20text&start=0&end=11&prefix=&suffix=)"
        #expect(AssistantCitationText.plainText("Before " + link + " after") == "Before Quoted text after")
        #expect(AssistantCitationText.plainText(String(link.dropLast()) + "&comment=Do%20this)") == "Quoted text\nComment: Do this")
        #expect(AssistantCitationText.plainText(link.replacingOccurrences(of: "%20", with: "+")) == "Quoted text")
        let invalid = "[Assistant quote](t3-citation://v1/env/thread/message?text=bad)"
        #expect(AssistantCitationText.plainText(invalid) == invalid)
        #expect(AssistantCitationText.plainText(link + " " + link) == "Quoted text Quoted text")
    }
}
