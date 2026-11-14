// The app target imports Expo modules as `internal`; an implicit import here is an
// "ambiguous implicit access level" error.
internal import ExpoModulesCore

struct FocusEnvironmentRecord: Record {
  @Field var id: String = ""
  @Field var label: String = ""
}

class T3FocusFilter: Module {
  private var observer: NSObjectProtocol?

  func definition() -> ModuleDefinition {
    Name("T3FocusFilter")
    Events("onChange")

    Function("setEnvironments") { (environments: [FocusEnvironmentRecord]) in
      FocusFilterStore.setEnvironments(
        environments.map { FocusEnvironmentEntity(id: $0.id, label: $0.label) })
    }

    AsyncFunction("getAllowedEnvironmentIds") { () async throws -> [String]? in
      try await EnvironmentFocusFilter.current.allowedEnvironmentIds
    }

    OnStartObserving {
      self.observer = NotificationCenter.default.addObserver(
        forName: .t3FocusFilterChanged, object: nil, queue: nil
      ) { [weak self] notification in
        let ids = notification.userInfo?["environmentIds"] as? [String]
        self?.sendEvent("onChange", ["environmentIds": ids.map { $0 as Any } ?? NSNull()])
      }
    }

    OnStopObserving {
      self.observer.map(NotificationCenter.default.removeObserver)
      self.observer = nil
    }
  }
}
