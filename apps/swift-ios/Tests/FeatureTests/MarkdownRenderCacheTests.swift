import Testing
@testable import T3Code

@Suite("Markdown render cache")
struct MarkdownRenderCacheTests {
    @Test
    func contentRevisionUsesExactSourceIdentity() {
        let first = MarkdownContentRevision("Same text")
        let again = MarkdownContentRevision("Same text")
        let changed = MarkdownContentRevision("Same text.")

        #expect(first == again)
        #expect(first != changed)
        #expect(first.fingerprint == again.fingerprint)
    }

    @Test
    func reusesAnExactRenderedDocument() async {
        let cache = MarkdownRenderCache(documentCountLimit: 8, documentCostLimit: 64_000)
        let revision = MarkdownContentRevision("# Heading\n\nBody with **emphasis**.")

        #expect(cache.cachedDocument(for: revision) == nil)
        guard let first = await cache.document(for: revision),
              let second = await cache.document(for: revision) else {
            Issue.record("Expected Markdown documents")
            return
        }

        #expect(first === second)
        #expect(cache.cachedDocument(for: revision) === first)
        #expect(first.blocks.count == 2)
    }

    @Test
    func immediatelyRendersAndCachesCompletedContent() {
        let cache = MarkdownRenderCache(documentCountLimit: 8, documentCostLimit: 64_000)
        let revision = MarkdownContentRevision("# Stable heading\n\n- First\n- Second")

        guard let document = cache.documentImmediately(for: revision) else {
            Issue.record("Expected an immediate Markdown document")
            return
        }

        #expect(cache.cachedDocument(for: revision) === document)
        #expect(document.blocks.count == 2)
    }

    @Test
    func coalescesConcurrentRequestsForOneRevision() async {
        let cache = MarkdownRenderCache(documentCountLimit: 8, documentCostLimit: 64_000)
        let revision = MarkdownContentRevision("A paragraph with `code` and [a link](https://t3.gg).")

        async let first = cache.document(for: revision)
        async let second = cache.document(for: revision)
        let documents = await (first, second)

        guard let first = documents.0, let second = documents.1 else {
            Issue.record("Expected coalesced Markdown documents")
            return
        }
        #expect(first === second)
    }

    @Test
    func reusesUnchangedInlineRunsAcrossStreamingRevisions() async {
        let cache = MarkdownRenderCache(documentCountLimit: 8, documentCostLimit: 64_000)
        guard let first = await cache.document(
            for: MarkdownContentRevision("Shared **paragraph**.\n\nFirst ending")
        ), let second = await cache.document(
            for: MarkdownContentRevision("Shared **paragraph**.\n\nSecond ending")
        ) else {
            Issue.record("Expected streaming Markdown documents")
            return
        }

        guard let firstBlock = first.blocks.first,
              let secondBlock = second.blocks.first,
              case let .paragraph(firstInline) = firstBlock,
              case let .paragraph(secondInline) = secondBlock else {
            Issue.record("Expected a shared leading paragraph")
            return
        }

        #expect(firstInline === secondInline)
        #expect(firstInline.style == .body)
        #expect(String(firstInline.attributedText.characters) == "Shared paragraph.")
    }

    @Test
    func canceledRequestDoesNotRenderOrCache() async {
        let cache = MarkdownRenderCache(documentCountLimit: 8, documentCostLimit: 64_000)
        let revision = MarkdownContentRevision(String(repeating: "Paragraph.\n\n", count: 2_000))
        let render = Task {
            await Task.yield()
            return await cache.document(for: revision)
        }

        render.cancel()
        #expect(await render.value == nil)
        #expect(cache.cachedDocument(for: revision) == nil)
    }
}
