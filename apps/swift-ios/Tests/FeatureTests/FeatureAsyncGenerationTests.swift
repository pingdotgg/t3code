import Testing
@testable import T3Code

struct FeatureAsyncGenerationTests {
    @Test
    func asyncGenerationRejectsAnOlderCompletionAfterANewerOperationBegins() {
        var generation = FeatureAsyncGeneration()
        let staleLoad = generation.begin()
        let mutation = generation.begin()

        #expect(!generation.accepts(staleLoad))
        #expect(generation.accepts(mutation))
    }

}
