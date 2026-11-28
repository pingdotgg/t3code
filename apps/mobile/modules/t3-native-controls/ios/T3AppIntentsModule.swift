import ExpoModulesCore
import os

public enum T3DictationIntentInbox {
  static let didDeliver = Notification.Name("T3DictationIntentInbox.didDeliver")
  private static let pending = OSAllocatedUnfairLock(initialState: false)

  public static func deliver() {
    pending.withLock { $0 = true }
    NotificationCenter.default.post(name: didDeliver, object: nil)
  }

  static func take() -> Bool {
    pending.withLock { value in
      defer { value = false }
      return value
    }
  }
}

public final class T3AppIntentsModule: Module {
  private var observer: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("T3AppIntents")

    Events("onStartDictation")

    Function("takePendingDictation") { () -> Bool in
      T3DictationIntentInbox.take()
    }

    OnStartObserving {
      self.observer = NotificationCenter.default.addObserver(
        forName: T3DictationIntentInbox.didDeliver,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.sendEvent("onStartDictation")
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
