import ExpoModulesCore
import os

/// Holds the last App Intent until JS takes it; cold launches run the intent before JS listens.
public enum T3AppIntentInbox {
  public static let newTask = "newTask"
  public static let voiceTask = "voiceTask"

  static let didDeliver = Notification.Name("T3AppIntentInbox.didDeliver")
  private static let pending = OSAllocatedUnfairLock<String?>(initialState: nil)

  public static func deliver(_ intent: String) {
    pending.withLock { $0 = intent }
    NotificationCenter.default.post(name: didDeliver, object: nil)
  }

  static func take() -> String? {
    pending.withLock { value in
      defer { value = nil }
      return value
    }
  }
}

public final class T3AppIntentsModule: Module {
  private var observer: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("T3AppIntents")

    Events("onIntent")

    Function("takePendingIntent") { () -> String? in
      T3AppIntentInbox.take()
    }

    OnStartObserving {
      self.observer = NotificationCenter.default.addObserver(
        forName: T3AppIntentInbox.didDeliver,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.sendEvent("onIntent")
      }
    }

    OnStopObserving {
      if let observer = self.observer {
        NotificationCenter.default.removeObserver(observer)
        self.observer = nil
      }
    }
  }
}
