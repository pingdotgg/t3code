import AVFoundation
import ExpoModulesCore
import Foundation

public final class T3VoiceAudioSessionModule: Module {
  private var observers: [NSObjectProtocol] = []
  private var currentActivationToken: Int?
  private var nextActivationToken = 0

  public func definition() -> ModuleDefinition {
    Name("T3VoiceAudioSession")
    Events("onVoiceAudioSessionEvent")

    Function("start") {
      self.startSessionOnMainThread()
    }

    Function("stop") { (activationToken: Int) in
      self.stopSessionOnMainThread(activationToken: activationToken)
    }

    OnDestroy {
      self.stopCurrentSessionOnMainThread()
    }
  }

  private func startSessionOnMainThread() -> Int {
    if Thread.isMainThread {
      return startSession()
    }
    return DispatchQueue.main.sync {
      self.startSession()
    }
  }

  private func startSession() -> Int {
    if let activationToken = currentActivationToken {
      return activationToken
    }

    let activationToken = allocateActivationToken()
    currentActivationToken = activationToken
    installObservers(session: AVAudioSession.sharedInstance(), activationToken: activationToken)
    return activationToken
  }

  private func allocateActivationToken() -> Int {
    nextActivationToken = nextActivationToken == 2_147_483_647 ? 1 : nextActivationToken + 1
    return nextActivationToken
  }

  private func installObservers(session: AVAudioSession, activationToken: Int) {
    let center = NotificationCenter.default
    observers.append(
      center.addObserver(
        forName: AVAudioSession.interruptionNotification,
        object: session,
        queue: .main
      ) { [weak self] notification in
        guard
          let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          AVAudioSession.InterruptionType(rawValue: rawType) == .began
        else { return }
        self?.emit("interruption", activationToken: activationToken)
      }
    )
    observers.append(
      center.addObserver(
        forName: AVAudioSession.routeChangeNotification,
        object: session,
        queue: .main
      ) { [weak self] notification in
        guard
          let rawReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
          let reason = AVAudioSession.RouteChangeReason(rawValue: rawReason),
          reason == .oldDeviceUnavailable || reason == .noSuitableRouteForCategory
        else { return }
        self?.emit("route_lost", activationToken: activationToken)
      }
    )
    observers.append(
      center.addObserver(
        forName: AVAudioSession.mediaServicesWereResetNotification,
        object: session,
        queue: .main
      ) { [weak self] _ in
        self?.emit("media_services_reset", activationToken: activationToken)
      }
    )
  }

  private func emit(_ kind: String, activationToken: Int) {
    guard currentActivationToken == activationToken else { return }
    sendEvent(
      "onVoiceAudioSessionEvent",
      ["kind": kind, "activationToken": activationToken]
    )
  }

  private func stopSessionOnMainThread(activationToken: Int) {
    if Thread.isMainThread {
      stopSession(activationToken: activationToken)
    } else {
      DispatchQueue.main.sync {
        self.stopSession(activationToken: activationToken)
      }
    }
  }

  private func stopCurrentSessionOnMainThread() {
    if Thread.isMainThread {
      stopCurrentSession()
    } else {
      DispatchQueue.main.sync {
        self.stopCurrentSession()
      }
    }
  }

  private func stopSession(activationToken: Int) {
    guard currentActivationToken == activationToken else { return }
    stopCurrentSession()
  }

  private func stopCurrentSession() {
    guard currentActivationToken != nil else { return }
    currentActivationToken = nil
    let center = NotificationCenter.default
    for observer in observers {
      center.removeObserver(observer)
    }
    observers.removeAll()
  }
}
