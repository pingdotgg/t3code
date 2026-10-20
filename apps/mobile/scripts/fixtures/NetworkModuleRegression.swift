import Foundation

enum NWInterface {
  enum InterfaceType {
    case other, wifi, cellular, loopback, wiredEthernet
  }
}

struct NWPath {
  enum Status {
    case satisfied, unsatisfied
  }

  // A reference inside the value models the native path's retained storage.
  final class Storage {
    let type: NWInterface.InterfaceType
    init(_ type: NWInterface.InterfaceType) { self.type = type }
  }

  let status: Status
  let storage: Storage

  init(_ type: NWInterface.InterfaceType, status: Status = .satisfied) {
    self.status = status
    storage = Storage(type)
  }

  func usesInterfaceType(_ type: NWInterface.InterfaceType) -> Bool {
    storage.type == type
  }
}

final class NWPathMonitor {
  static var scenario = "first"
  static let deliveries = DispatchGroup()
  var pathUpdateHandler: ((NWPath) -> Void)?

  func start(queue: DispatchQueue) {
    guard let handler = pathUpdateHandler else { fatalError("Missing path handler") }
    if Self.scenario == "offline" {
      handler(NWPath(.wifi, status: .unsatisfied))
    } else if Self.scenario == "first" {
      handler(NWPath(.wifi))
      handler(NWPath(.cellular))
    } else {
      queue.async(group: Self.deliveries) {
        handler(NWPath(.wifi))
        DispatchQueue.concurrentPerform(iterations: 128) { index in
          handler(NWPath(index.isMultiple(of: 2) ? .cellular : .wiredEthernet))
        }
      }
    }
  }

  // Already queued callbacks can run after cancellation.
  func cancel() {}
}

@main
enum NetworkModuleRegression {
  static func main() {
    NWPathMonitor.scenario = CommandLine.arguments[1]
    let module = NetworkModule()
    if NWPathMonitor.scenario == "concurrent" {
      DispatchQueue.concurrentPerform(iterations: 64) { _ in
        let state = module.getNetworkStateAsync()
        precondition(state["type"] as? String == "WIFI", "The first path must survive late callbacks")
        precondition(state["isConnected"] as? Bool == true)
      }
      NWPathMonitor.deliveries.wait()
    } else {
      let state = module.getNetworkStateAsync()
      let connected = NWPathMonitor.scenario != "offline"
      precondition(state["type"] as? String == (connected ? "WIFI" : "NONE"))
      precondition(state["isConnected"] as? Bool == connected)
      precondition(state["isInternetReachable"] as? Bool == connected)
    }
    print("passed")
  }
}
