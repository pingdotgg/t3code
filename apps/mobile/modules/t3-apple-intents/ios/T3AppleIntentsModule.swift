import ExpoModulesCore
import Foundation

public final class T3AppleIntentsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3AppleIntents")

    Function("isSupported") { () -> Bool in
      T3IntentsRuntime.isSupportedOS
    }

    AsyncFunction("syncIndex") { (json: String) async throws in
      try await T3IntentsRuntime.shared.syncIndexJSON(json)
    }

    AsyncFunction("removeEnvironment") { (environmentId: String) async throws in
      try await T3IntentsRuntime.shared.removeEnvironment(environmentId: environmentId)
    }

    AsyncFunction("clearIndex") { () async throws in
      try await T3IntentsRuntime.shared.clearIndex()
    }

    Function("setOnscreenContext") { (json: String?) in
      T3IntentsRuntime.shared.setOnscreenContextJSON(json)
    }

    AsyncFunction("syncAuthCredentials") { (json: String) throws in
      try T3IntentsRuntime.shared.syncAuthCredentialsJSON(json)
    }
  }
}
