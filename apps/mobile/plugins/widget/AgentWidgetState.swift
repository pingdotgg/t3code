import Foundation

// A confirmed relay read renews relay observations. Direct-only rows keep the
// app's original deadline; an empty relay never claims that they finished.
enum AgentWidgetState {
  static func timeline(aggregate: [String: Any]?, environmentIds: [String], localObservation: [String: Any]?, now: Date) -> [[String: Any]] {
    let freshnessDeadline = now.addingTimeInterval(60 * 60)
    var base = aggregate ?? [
      "title": "T3 Code", "subtitle": "No active agents", "activeCount": 0,
      "updatedAt": ISO8601DateFormatter().string(from: now), "activities": [[String: Any]]()
    ]
    base = base.filter { !($0.value is NSNull) }
    base["isExpired"] = false
    base["isStale"] = false
    base["expiresAt"] = freshnessDeadline.timeIntervalSince1970 * 1000
    let covered = Set(environmentIds)
    let relayRows = base["activities"] as? [[String: Any]] ?? []
    let localRows = (localObservation?["activities"] as? [[String: Any]] ?? []).filter {
      guard let environmentId = $0["environmentId"] as? String else { return false }
      return !covered.contains(environmentId)
    }
    let localDeadline = (localObservation?["expiresAt"] as? NSNumber).map {
      Date(timeIntervalSince1970: $0.doubleValue / 1000)
    }
    func merged(at date: Date) -> [String: Any] {
      var props = base
      let directRows = localRows.map { row in
        localDeadline.map { $0 > date } == true ? row : stale(row)
      }
      props["activities"] = relayRows + directRows
      let unavailable = directRows.contains { $0["phase"] as? String == "stale" }
      let directCount = directRows.filter { isUnfinished($0) }.count
      props["activeCount"] = unavailable ? -1 : (base["activeCount"] as? Int ?? 0) + directCount
      return props
    }
    var entries = [entry(at: now, props: merged(at: now))]
    if let localDeadline, localDeadline > now, localDeadline < freshnessDeadline, localRows.contains(where: isUnfinished) {
      entries.append(entry(at: localDeadline, props: merged(at: localDeadline)))
    }
    var expired = merged(at: freshnessDeadline)
    expired["activities"] = (expired["activities"] as? [[String: Any]] ?? []).map(stale)
    expired["activeCount"] = -1
    expired["isExpired"] = true
    expired["subtitle"] = "Open T3 to refresh"
    entries.append(entry(at: freshnessDeadline, props: expired))
    return entries
  }

  private static func isUnfinished(_ row: [String: Any]) -> Bool {
    let phase = row["phase"] as? String
    return phase != "completed" && phase != "failed" && phase != "stale"
  }

  private static func stale(_ row: [String: Any]) -> [String: Any] {
    let phase = row["phase"] as? String
    guard phase != "completed" && phase != "failed" else { return row }
    var result = row
    result["phase"] = "stale"
    result["status"] = "Out of date"
    return result
  }

  private static func entry(at date: Date, props: [String: Any]) -> [String: Any] {
    ["timestamp": Int(date.timeIntervalSince1970 * 1000), "props": props]
  }
}
