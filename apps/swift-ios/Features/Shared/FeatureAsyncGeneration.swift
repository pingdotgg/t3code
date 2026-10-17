struct FeatureAsyncGeneration {
    private var value: UInt64 = 0

    mutating func begin() -> UInt64 {
        value &+= 1
        return value
    }

    func accepts(_ generation: UInt64) -> Bool {
        generation == value
    }
}
