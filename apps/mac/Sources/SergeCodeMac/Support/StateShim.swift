import SwiftUI

// The macOS 27 beta SDK turns SwiftUI's `@State` (and `@Entry`) attributes into
// compiler macros implemented by a `SwiftUIMacros` plugin that ships only with
// Xcode — Command Line Tools builds fail with "plugin for module 'SwiftUIMacros'
// not found". The underlying `State<Value>` property-wrapper struct is still
// public, so this shim delegates to it. Use `@UIState` everywhere in this app
// instead of `@State`; for custom environment values, write manual
// `EnvironmentKey` conformances instead of `@Entry`.
@propertyWrapper
public struct UIState<Value>: DynamicProperty {
    private var storage: State<Value>

    public init(wrappedValue: Value) {
        storage = State(initialValue: wrappedValue)
    }

    public init(initialValue: Value) {
        storage = State(initialValue: initialValue)
    }

    public var wrappedValue: Value {
        get { storage.wrappedValue }
        nonmutating set { storage.wrappedValue = newValue }
    }

    public var projectedValue: Binding<Value> {
        storage.projectedValue
    }
}
