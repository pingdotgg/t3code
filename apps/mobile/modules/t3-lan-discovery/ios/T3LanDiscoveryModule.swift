import Darwin
import ExpoModulesCore
import Foundation

public final class T3LanDiscoveryModule: Module {
  private var discovery: Discovery?

  public func definition() -> ModuleDefinition {
    Name("T3LanDiscovery")
    Events("servicesChanged")

    AsyncFunction("start") {
      if self.discovery == nil {
        self.discovery = Discovery { [weak self] services in
          self?.sendEvent("servicesChanged", ["services": services])
        }
        self.discovery?.start()
      }
    }.runOnQueue(.main)

    AsyncFunction("stop") {
      self.discovery?.stop()
      self.discovery = nil
    }.runOnQueue(.main)

    AsyncFunction("refresh") {
      self.discovery?.refresh()
    }.runOnQueue(.main)

    OnDestroy {
      DispatchQueue.main.async {
        self.discovery?.stop()
        self.discovery = nil
      }
    }
  }
}

private final class Discovery: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
  private let maxServices = 64
  private let maxResolves = 4
  private let emit: ([[String: Any]]) -> Void
  private var browser: NetServiceBrowser?
  private var services: [String: NetService] = [:]
  private var pending: [String] = []
  private var resolving: Set<String> = []
  private var records: [String: [String: Any]] = [:]

  init(emit: @escaping ([[String: Any]]) -> Void) {
    self.emit = emit
  }

  func start() {
    guard browser == nil else { return }
    let browser = NetServiceBrowser()
    self.browser = browser
    browser.delegate = self
    browser.searchForServices(ofType: "_t3code._tcp.", inDomain: "local.")
  }

  func stop() {
    browser?.delegate = nil
    browser?.stop()
    browser = nil
    for service in services.values {
      service.delegate = nil
      service.stop()
    }
    services.removeAll()
    pending.removeAll()
    resolving.removeAll()
    records.removeAll()
    emit([])
  }

  func refresh() {
    guard browser != nil else { return }
    stop()
    start()
  }

  private func id(_ service: NetService) -> String {
    "\(service.name).\(service.type)\(service.domain)"
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
    guard self.browser === browser else { return }
    let key = id(service)
    guard services[key] == nil, services.count < maxServices else { return }
    services[key] = service
    pending.append(key)
    resolveNext()
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
    guard self.browser === browser else { return }
    let key = id(service)
    guard let existing = services.removeValue(forKey: key) else { return }
    existing.delegate = nil
    existing.stop()
    pending.removeAll { $0 == key }
    resolving.remove(key)
    if records.removeValue(forKey: key) != nil { publish() }
    resolveNext()
  }

  private func resolveNext() {
    while resolving.count < maxResolves, !pending.isEmpty {
      let key = pending.removeFirst()
      guard let service = services[key] else { continue }
      resolving.insert(key)
      service.delegate = self
      service.resolve(withTimeout: 5)
    }
  }

  func netServiceDidResolveAddress(_ sender: NetService) {
    let key = id(sender)
    guard services[key] === sender, resolving.remove(key) != nil else { return }
    defer { resolveNext() }
    guard let data = sender.txtRecordData(),
          let value = NetService.dictionary(fromTXTRecord: data)["environmentId"],
          let environmentId = String(data: value, encoding: .utf8), !environmentId.isEmpty,
          sender.port > 0, sender.port <= 65535 else { return }
    let addresses = Set((sender.addresses ?? []).compactMap { data -> String? in
      data.withUnsafeBytes { bytes -> String? in
        guard let address = bytes.baseAddress?.assumingMemoryBound(to: sockaddr.self),
              bytes.count >= MemoryLayout<sockaddr_in>.size,
              address.pointee.sa_family == sa_family_t(AF_INET) else { return nil }
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        guard getnameinfo(address, socklen_t(bytes.count), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { return nil }
        return String(cString: host)
      }
    }).sorted()
    guard !addresses.isEmpty else { return }
    records[key] = ["id": key, "environmentId": environmentId, "addresses": addresses, "port": sender.port]
    publish()
  }

  func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
    let key = id(sender)
    guard services[key] === sender, resolving.remove(key) != nil else { return }
    resolveNext()
  }

  private func publish() {
    emit(records.keys.sorted().compactMap { records[$0] })
  }
}
