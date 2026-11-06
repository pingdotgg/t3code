import Foundation

if CommandLine.arguments.count == 5, CommandLine.arguments[1] == "--stale-refresh" {
  let defaults = UserDefaults(suiteName: CommandLine.arguments[2])!
  let lock = URL(fileURLWithPath: CommandLine.arguments[3])
  FileHandle.standardOutput.write(Data("ready\n".utf8))
  let committed = AgentWidgetStorage.withLock(at: lock, defaults: defaults) {
    AgentWidgetStorage.commit([["timestamp": 0, "props": ["activities": ["old account"]]]],
      generation: CommandLine.arguments[4], in: $0)
  }
  exit(committed == false ? 0 : 1)
}

let now = Date(timeIntervalSince1970: 1000)
func row(_ environmentId: String, _ phase: String) -> [String: Any] {
  ["environmentId": environmentId, "phase": phase, "status": phase, "threadTitle": "Test agent"]
}
func props(_ entry: [String: Any]) -> [String: Any] { entry["props"] as! [String: Any] }
let running: [String: Any] = ["activeCount": 1, "updatedAt": "old unchanged observation", "activities": [row("relay", "running")]]
let local: [String: Any] = ["activeCount": 2, "expiresAt": now.addingTimeInterval(600).timeIntervalSince1970 * 1000,
  "activities": [row("relay", "running"), row("direct", "waiting_for_input"), row("direct", "failed")]]
let entries = AgentWidgetState.timeline(aggregate: running, environmentIds: ["relay"], localObservation: local, now: now)
assert(entries.count == 3)
assert(props(entries[0])["activeCount"] as? Int == 2)
let directExpired = props(entries[1])["activities"] as! [[String: Any]]
assert(directExpired.map { $0["phase"] as! String } == ["running", "stale", "failed"])
assert(props(entries[1])["isExpired"] as? Bool == false)
assert(props(entries[1])["activeCount"] as? Int == -1)
let fullyExpired = props(entries[2])["activities"] as! [[String: Any]]
assert(fullyExpired.map { $0["phase"] as! String } == ["stale", "stale", "failed"])
assert(props(entries[2])["isExpired"] as? Bool == true)
assert(entries[2]["timestamp"] as? Int == 4_600_000)

// A successful unchanged read renews freshness without inventing a state update.
let renewed = AgentWidgetState.timeline(aggregate: running, environmentIds: ["relay"], localObservation: nil, now: now.addingTimeInterval(300))
assert(renewed.last?["timestamp"] as? Int == 4_900_000)
assert(props(renewed[0])["updatedAt"] as? String == "old unchanged observation")

// An authoritative empty relay clears its own rows and retains direct observations.
let empty = AgentWidgetState.timeline(aggregate: nil, environmentIds: ["relay"], localObservation: local, now: now)
assert((props(empty[0])["activities"] as! [[String: Any]]).count == 2)
assert(props(empty[0])["activeCount"] as? Int == 1)
let terminals: [String: Any] = ["activeCount": 0, "optional": NSNull(), "activities": [row("relay", "completed"), row("relay", "failed")]]
let final = AgentWidgetState.timeline(aggregate: terminals, environmentIds: ["relay"], localObservation: nil, now: now)
assert((props(final.last!)["activities"] as! [[String: Any]]).map { $0["phase"] as! String } == ["completed", "failed"])
assert(PropertyListSerialization.propertyList(final, isValidFor: .binary))
print("AgentWidgetState: background renewal, source reconciliation, expiration, and native storage passed")

// Native background reads can replace JS's last idle publication. Sign-out must
// remove that timeline even when JS would deduplicate its next idle publication.
let suite = "t3-widget-signout-test-\(UUID().uuidString)"
let defaults = UserDefaults(suiteName: suite)!
defer { defaults.removePersistentDomain(forName: suite) }
defaults.set("previous-account", forKey: "t3_agent_widget_identity")
defaults.set("test-capability", forKey: "t3_agent_widget_token")
defaults.set("https://relay.test/v1/widget/agent-activity", forKey: "t3_agent_widget_url")
defaults.set("previous rows", forKey: "t3_agent_widget_local_observation")
defaults.set(entries, forKey: "__expo_widgets_AgentActivity_timeline")
defaults.set("install-push-token", forKey: "t3_agent_widget_push_token")
var pendingRevocations = [URLRequest]()
defaults.set("previous-generation", forKey: "t3_agent_widget_generation")
let revocation = T3AgentWidgetConfiguration.clearStoredState(in: defaults) { request in
  // Persist before active authority is removed, so interruption cannot lose it.
  assert(defaults.string(forKey: "t3_agent_widget_url") != nil)
  pendingRevocations.append(request)
  return true
}
let durableRevocation = pendingRevocations.first?.value(forHTTPHeaderField: "Authorization") == "Bearer test-capability"
let invalidatedGeneration = defaults.string(forKey: "t3_agent_widget_generation") != "previous-generation"
print("Revocation survives interrupted logout: \(durableRevocation ? "PASS" : "FAIL")")
print("Cached old-account entry loses ownership after logout: \(invalidatedGeneration ? "PASS" : "FAIL")")
assert(revocation?.httpMethod == "DELETE")
assert(revocation?.url?.absoluteString == "https://relay.test/v1/widget/agent-activity")
assert(revocation?.value(forHTTPHeaderField: "Authorization") == "Bearer test-capability")
for key in ["t3_agent_widget_identity", "t3_agent_widget_token", "t3_agent_widget_url", "t3_agent_widget_local_observation", "__expo_widgets_AgentActivity_timeline"] {
  assert(defaults.object(forKey: key) == nil)
}
assert(defaults.string(forKey: "t3_agent_widget_push_token") == "install-push-token")
assert(T3AgentWidgetConfiguration.clearStoredState(in: defaults) == nil)
print("Agent widget sign-out: cached rows removed and previous capability revocation prepared")

let saved = AgentWidgetCredential.Revocation(request: pendingRevocations[0])!
let restored = try JSONDecoder().decode(AgentWidgetCredential.Revocation.self, from: JSONEncoder().encode(saved))
assert(restored.request == revocation)
assert(restored.account == saved.account)
assert(!restored.account.contains("test-capability"))

// Failed secure storage keeps disabled authority recoverable for a later cleanup.
defaults.set("next-account", forKey: "t3_agent_widget_identity")
defaults.set("test-capability", forKey: "t3_agent_widget_token")
defaults.set("https://relay.test/v1/widget/agent-activity", forKey: "t3_agent_widget_url")
assert(T3AgentWidgetConfiguration.clearStoredState(in: defaults, storeRevocation: { _ in false }) == nil)
assert(defaults.string(forKey: "t3_agent_widget_identity") == nil)
assert(defaults.string(forKey: "t3_agent_widget_url") != nil)
assert(defaults.string(forKey: "t3_agent_widget_token") == "test-capability")
assert(T3AgentWidgetConfiguration.clearStoredState(in: defaults, storeRevocation: { _ in true }) != nil)
print("Agent widget revocation: secure-write failure retained for retry; durable record round-trip passed")

// The extension has captured its old owner before the app takes the shared lock.
let lock = FileManager.default.temporaryDirectory.appendingPathComponent("\(suite).lock")
defer { try? FileManager.default.removeItem(at: lock) }
let child = Process()
let ready = Pipe()
child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
child.standardOutput = ready
var previousProps: [String: Any]?
let transitioned = AgentWidgetStorage.withLock(at: lock, defaults: defaults) { defaults in
  let generation = AgentWidgetStorage.generation(in: defaults)
  assert(AgentWidgetStorage.commit(entries, generation: generation, in: defaults))
  previousProps = props((defaults.array(forKey: AgentWidgetStorage.timelineKey) as! [[String: Any]])[0])
  assert(AgentWidgetStorage.owns(previousProps, in: defaults))
  child.arguments = ["--stale-refresh", suite, lock.path, generation]
  try! child.run()
  assert(try! ready.fileHandleForReading.read(upToCount: 6) == Data("ready\n".utf8))
  T3AgentWidgetConfiguration.clearStoredState(in: defaults)
  defaults.set("new-account", forKey: "t3_agent_widget_identity")
  return true
}
assert(transitioned == true)
child.waitUntilExit()
assert(child.terminationStatus == 0)
assert(defaults.array(forKey: AgentWidgetStorage.timelineKey) == nil)
assert(!AgentWidgetStorage.owns(previousProps, in: defaults))
assert(!AgentWidgetStorage.owns(props(entries[0]), in: defaults))
assert(AgentWidgetStorage.commit(entries, generation: AgentWidgetStorage.generation(in: defaults), in: defaults))
print("Agent widget cross-process transition: stale commit rejected, retained and legacy entries rejected, new owner accepted")

// Truncated local rows cannot establish the total outside relay coverage.
var truncated = local
truncated["activeCount"] = 20
let truncatedEntries = AgentWidgetState.timeline(aggregate: running, environmentIds: ["relay"], localObservation: truncated, now: now)
assert(props(truncatedEntries[0])["activeCount"] as? Int == -1)
var unknown = local
unknown.removeValue(forKey: "activeCount")
assert(props(AgentWidgetState.timeline(aggregate: running, environmentIds: ["relay"], localObservation: unknown, now: now)[0])["activeCount"] as? Int == -1)

// Fully relay-covered rows must not invalidate an authoritative relay count.
let coveredUnknown: [String: Any] = ["activities": [row("relay", "running")]]
let coveredTimeline = AgentWidgetState.timeline(aggregate: running, environmentIds: ["relay"], localObservation: coveredUnknown, now: now)
assert(props(coveredTimeline[0])["activeCount"] as? Int == 1)

// Exact relay totals survive native background merges, including capped rows.
let counted: [String: Any] = ["activeCount": 12, "workingCount": 8, "attentionCount": 4, "totalCount": 20, "activities": [row("relay", "running")]]
var countedLocal = local
countedLocal["totalCount"] = 3
let countedEntries = AgentWidgetState.timeline(aggregate: counted, environmentIds: ["relay"], localObservation: countedLocal, now: now)
assert(props(countedEntries[0])["workingCount"] as? Int == 8)
assert(props(countedEntries[0])["attentionCount"] as? Int == 5)
assert(props(countedEntries[0])["totalCount"] as? Int == 22)
assert(props(countedEntries[1])["workingCount"] == nil)
assert(props(countedEntries.last!)["attentionCount"] == nil)
print("Agent widget counts: working, attention, overflow, and stale merges passed")
assert(durableRevocation && invalidatedGeneration)

// Direct-only JS observations carry unknown counts as JSON null.
let storageGeneration = AgentWidgetStorage.generation(in: defaults)
let unknownCounts: [[String: Any]] = [["timestamp": 0, "props": [
  "activeCount": -1, "workingCount": NSNull(), "attentionCount": NSNull(),
  "totalCount": NSNull(), "activities": [row("direct", "running")]
]]]
assert(AgentWidgetStorage.commit(unknownCounts, generation: storageGeneration, in: defaults))
let storedEntries = defaults.array(forKey: AgentWidgetStorage.timelineKey) as! [[String: Any]]
assert(PropertyListSerialization.propertyList(storedEntries, isValidFor: .binary))
let storedProps = props(storedEntries[0])
for key in ["workingCount", "attentionCount", "totalCount"] { assert(storedProps[key] == nil) }
assert(storedProps["activeCount"] as? Int == -1)
assert((storedProps["activities"] as? [[String: Any]])?.count == 1)
assert(AgentWidgetStorage.owns(storedProps, in: defaults))
print("Unknown direct-only counts persist without invalid property-list nulls")
