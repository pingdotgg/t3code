/// Lines shown by a review diff while its full file contents load. A failed
/// load keeps the lines already on screen and reports the error for Retry;
/// a completion from a superseded attempt is ignored.
struct FeatureDiffHydration {
    private(set) var lines: [FeatureDiffLine]
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private var generation = FeatureAsyncGeneration()

    init(lines: [FeatureDiffLine]) {
        self.lines = lines
    }

    mutating func begin() -> UInt64 {
        errorMessage = nil
        isLoading = true
        return generation.begin()
    }

    /// `nil` means the server has no full contents, so the patch lines stay.
    mutating func succeed(_ attempt: UInt64, lines loaded: [FeatureDiffLine]?) {
        guard generation.accepts(attempt) else { return }
        if let loaded { lines = loaded }
        isLoading = false
    }

    mutating func fail(_ attempt: UInt64, message: String) {
        guard generation.accepts(attempt) else { return }
        errorMessage = message
        isLoading = false
    }

    mutating func cancel(_ attempt: UInt64) {
        guard generation.accepts(attempt) else { return }
        isLoading = false
    }
}
