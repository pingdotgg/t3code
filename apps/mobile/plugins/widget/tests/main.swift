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
  ["environmentId": environmentId, "threadId": environmentId + "-" + phase, "updatedAt": "2026-01-01T00:00:00Z", "phase": phase, "status": phase, "threadTitle": "Test agent"]
}
func props(_ entry: [String: Any]) -> [String: Any] { entry["props"] as! [String: Any] }
let running: [String: Any] = ["activeCount": 1, "totalCount": 1, "updatedAt": "old unchanged observation", "activities": [row("relay", "running")]]
let local: [String: Any] = ["activeCount": 2, "totalCount": 3, "expiresAt": now.addingTimeInterval(600).timeIntervalSince1970 * 1000,
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

// An empty relay cannot confirm that observed unfinished work ended.
let empty = AgentWidgetState.timeline(aggregate: nil, environmentIds: ["relay"], localObservation: local, now: now)
assert((props(empty[0])["activities"] as! [[String: Any]]).count == 3)
assert(props(empty[0])["activeCount"] as? Int == 2)
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
let revocation = AgentWidgetStorage.clearStoredState(in: defaults, readCredential: { .missing }) { request in
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
assert(AgentWidgetStorage.clearStoredState(in: defaults, readCredential: { .missing }) == nil)
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
assert(AgentWidgetStorage.clearStoredState(in: defaults, readCredential: { .missing }, storeRevocation: { _ in false }) == nil)
assert(defaults.string(forKey: "t3_agent_widget_identity") == nil)
assert(defaults.string(forKey: "t3_agent_widget_url") != nil)
assert(defaults.string(forKey: "t3_agent_widget_token") == "test-capability")
assert(!AgentWidgetStorage.canCreateCredential(in: defaults, credential: .missing))
var retriedPreparation = false
AgentWidgetStorage.prepareRevocations(in: defaults, readCredential: { .missing }) { _ in retriedPreparation = true; return true }
assert(retriedPreparation)
assert(defaults.string(forKey: "t3_agent_widget_url") == nil)
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
  AgentWidgetStorage.clearStoredState(in: defaults, readCredential: { .missing })
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

// Capped relay rows can hide direct work whose environment is still unconfirmed.
let cappedObservation: [String: Any] = [
  "activeCount": 6, "workingCount": 1, "attentionCount": 5, "totalCount": 6,
  "activities": (0..<5).map { _ in row("relay", "waiting_for_approval") },
  "observedEnvironmentIds": ["relay", "direct"]
]
let completedRelay: [String: Any] = [
  "activeCount": 0, "workingCount": 0, "attentionCount": 0, "totalCount": 5,
  "activities": (0..<5).map { _ in row("relay", "completed") }
]
let cappedTimeline = AgentWidgetState.timeline(aggregate: completedRelay, environmentIds: ["relay"], localObservation: cappedObservation, now: now)
assert(props(cappedTimeline[0])["activeCount"] as? Int == -1)
assert(props(cappedTimeline[0])["workingCount"] == nil)
assert(props(cappedTimeline[0])["attentionCount"] == nil)
var cappedTerminalObservation = cappedObservation
cappedTerminalObservation["activeCount"] = 5
cappedTerminalObservation["workingCount"] = 0
let cappedTerminalTimeline = AgentWidgetState.timeline(aggregate: completedRelay, environmentIds: ["relay"], localObservation: cappedTerminalObservation, now: now)
assert(props(cappedTerminalTimeline[0])["activeCount"] as? Int == -1)
assert(props(cappedTerminalTimeline[0])["totalCount"] == nil)
let coveredCappedTimeline = AgentWidgetState.timeline(aggregate: completedRelay, environmentIds: ["relay", "direct"], localObservation: cappedObservation, now: now)
assert(props(coveredCappedTimeline[0])["activeCount"] as? Int == -1)

// Fully relay-covered rows must not invalidate an authoritative relay count.
let coveredUnknown: [String: Any] = ["activeCount": 1, "totalCount": 1, "activities": [row("relay", "running")]]
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

// Links cannot acknowledge a newer direct approval or running observation.
for phase in ["running", "waiting_for_approval"] {
  var direct = row("relay", phase)
  direct["threadId"] = "same-thread"
  direct["updatedAt"] = "2026-01-02T00:00:00Z"
  var old = row("relay", "completed")
  old["threadId"] = "same-thread"
  let observed: [String: Any] = ["activeCount": 1, "totalCount": 1, "observedEnvironmentIds": ["relay"], "expiresAt": 1_600_000, "activities": [direct]]
  let remote: [String: Any] = ["activeCount": 0, "totalCount": 1, "activities": [old]]
  let result = AgentWidgetState.timeline(aggregate: remote, environmentIds: ["relay"], localObservation: observed, now: now)
  assert((props(result[0])["activities"] as! [[String: Any]]).map { $0["phase"] as! String } == [phase])
  assert(props(result[0])["activeCount"] as? Int == 1)
  assert(result[1]["timestamp"] as? Int == 1_600_000)
}
print("Unconfirmed linked observations survive older terminal and capped reads")

let revocations = [saved]
assert(AgentWidgetStorage.claimRevocations(revocations, in: defaults, now: now).count == 1)
assert(AgentWidgetStorage.claimRevocations(revocations, in: defaults, now: now).isEmpty)
AgentWidgetStorage.finishRevocation(account: saved.account, in: defaults)
assert(AgentWidgetStorage.claimRevocations(revocations, in: defaults, now: now).count == 1)
assert(AgentWidgetStorage.claimRevocations(revocations, in: defaults, now: now.addingTimeInterval(31)).count == 1)
let firstRequest = AgentWidgetStorage.beginRefresh(in: defaults)
let newerRequest = AgentWidgetStorage.beginRefresh(in: defaults)
assert(AgentWidgetStorage.commit(entries, generation: storageGeneration, requestId: newerRequest, in: defaults))
assert(!AgentWidgetStorage.commit(entries, generation: storageGeneration, requestId: firstRequest, in: defaults))
print("Revocation retries deduplicate across shared storage; superseded reads cannot commit")

// Relay rotation preserves the old destination before clearing its capability.
defaults.set("same-owner", forKey: "t3_agent_widget_identity")
defaults.set("old-capability", forKey: "t3_agent_widget_token")
defaults.set("https://old-relay.test/v1/widget/agent-activity", forKey: "t3_agent_widget_url")
var rotationRevocations = [URLRequest]()
assert(!AgentWidgetStorage.prepareRelay(url: "https://new-relay.test/v1/widget/agent-activity", in: defaults, readCredential: { .missing }, storeRevocation: { _ in false }))
assert(defaults.string(forKey: "t3_agent_widget_url") == "https://old-relay.test/v1/widget/agent-activity")
assert(defaults.string(forKey: "t3_agent_widget_token") == "old-capability")
assert(AgentWidgetStorage.prepareRelay(url: "https://new-relay.test/v1/widget/agent-activity", in: defaults, readCredential: { .missing }, storeRevocation: { request in
  rotationRevocations.append(request)
  return true
}))
assert(rotationRevocations.count == 1)
assert(rotationRevocations[0].url?.host == "old-relay.test")
assert(rotationRevocations[0].value(forHTTPHeaderField: "Authorization") == "Bearer old-capability")
assert(defaults.string(forKey: "t3_agent_widget_url") == nil)
assert(defaults.string(forKey: "t3_agent_widget_token") == nil)
assert(defaults.string(forKey: "t3_agent_widget_identity") == nil)
print("Relay URL rotation: failed preservation stays recoverable; old URL/token persist before new authority")
// Uncapped source rows let native refresh reconcile each environment independently.
var observedRow = row("relay", "running")
observedRow["threadId"] = "observed"
var hiddenRow = row("relay", "running")
hiddenRow["threadId"] = "hidden"
var completedRow = observedRow
completedRow["phase"] = "completed"
completedRow["updatedAt"] = "2026-01-02T00:00:00Z"
var completedHidden = hiddenRow
completedHidden["phase"] = "completed"
completedHidden["updatedAt"] = "2026-01-02T00:00:00Z"
let cappedLocal: [String: Any] = ["activeCount": 2, "totalCount": 2, "expiresAt": 1_600_000,
  "observedEnvironmentIds": ["relay"], "activities": [observedRow],
  "observedActivities": ["relay": [observedRow, hiddenRow]]]
let reconciledRelay: [String: Any] = ["activeCount": 0, "totalCount": 2, "activities": [completedRow, completedHidden]]
let reconciled = props(AgentWidgetState.timeline(aggregate: reconciledRelay, environmentIds: ["relay"], localObservation: cappedLocal, now: now)[0])
assert(reconciled["activeCount"] as? Int == 0)
assert((reconciled["activities"] as! [[String: Any]]).allSatisfy { $0["phase"] as? String == "completed" })
let partialRelay: [String: Any] = ["activeCount": 0, "totalCount": 1, "activities": [completedRow]]
let partial = props(AgentWidgetState.timeline(aggregate: partialRelay, environmentIds: ["relay"], localObservation: cappedLocal, now: now)[0])
assert(partial["activeCount"] as? Int == 2)
assert((partial["activities"] as! [[String: Any]]).count == 1)
print("Capped observations: newer relay rows reconcile all source rows; hidden unfinished rows remain protected")


var mixedObservation = cappedLocal
mixedObservation["observedActivities"] = ["relay": [observedRow, hiddenRow], "direct": [row("direct", "running")]]
mixedObservation["activities"] = [observedRow, row("direct", "running")]
let mixedEntries = AgentWidgetState.timeline(aggregate: reconciledRelay, environmentIds: ["relay"], localObservation: mixedObservation, now: now)
let mixed = props(mixedEntries[0])
assert(mixed["activeCount"] as? Int == 1)
assert(mixed["totalCount"] as? Int == 3)
assert((mixed["activities"] as! [[String: Any]]).map { $0["phase"] as! String } == ["completed", "completed", "running"])
assert(props(mixedEntries[1])["activeCount"] as? Int == -1)
var hiddenOnly = cappedLocal
hiddenOnly["activities"] = [[String: Any]]()
let hiddenEntries = AgentWidgetState.timeline(aggregate: nil, environmentIds: [], localObservation: hiddenOnly, now: now)
assert(props(hiddenEntries[0])["activeCount"] as? Int == 2)
assert(hiddenEntries[1]["timestamp"] as? Int == 1_600_000)
assert(props(hiddenEntries[1])["activeCount"] as? Int == -1)
print("Per-environment reconciliation releases confirmed scopes, preserves exact hidden counts, and expires hidden work")

defaults.set("https://locked-relay.test/v1/widget/agent-activity", forKey: "t3_agent_widget_url")
_ = AgentWidgetStorage.clearStoredState(in: defaults, readCredential: { .unavailable })
assert(defaults.string(forKey: "t3_agent_widget_url") != nil, "Failed Keychain lookup must retain revocation destination")

assert(!AgentWidgetStorage.canCreateCredential(in: defaults, credential: .unavailable))
assert(!AgentWidgetStorage.prepareRelay(url: "https://new-relay.test", in: defaults, readCredential: { .unavailable }))
var recovered = [URLRequest]()
_ = AgentWidgetStorage.clearStoredState(in: defaults, readCredential: { .available("recovered-token") }) { request in
  recovered.append(request)
  return true
}
assert(recovered.first?.url?.host == "locked-relay.test")
assert(recovered.first?.value(forHTTPHeaderField: "Authorization") == "Bearer recovered-token")
assert(AgentWidgetStorage.canCreateCredential(in: defaults, credential: .missing))
print("Unavailable secure reads retain old revocation routing; legacy cleanup blocks replacement")

var staleLocal = local
staleLocal["isStale"] = true
assert(props(AgentWidgetState.timeline(aggregate: running, environmentIds: ["relay"], localObservation: staleLocal, now: now)[0])["isStale"] as? Bool == true)
staleLocal["activities"] = [row("relay", "running")]
staleLocal["totalCount"] = 1
staleLocal["activeCount"] = 1
assert(props(AgentWidgetState.timeline(aggregate: running, environmentIds: ["relay"], localObservation: staleLocal, now: now)[0])["isStale"] as? Bool == false)
print("Last observed label survives until the relay confirms retained direct work")

func json(_ value: [String: Any]) -> String { String(data: try! JSONSerialization.data(withJSONObject: value, options: .sortedKeys), encoding: .utf8)! }
var observation: [String: Any] = ["activities": [observedRow], "observedActivities": ["relay": [observedRow]], "activeCount": 1, "expiresAt": 1_600_000]
var observationEntries: [[String: Any]] = [["timestamp": 0, "props": observation]]
assert(AgentWidgetStorage.observe(json(observation), entries: observationEntries, in: defaults))
let unchangedTimeline = defaults.array(forKey: AgentWidgetStorage.timelineKey)! as NSArray
observedRow["updatedAt"] = "2026-01-03T00:00:00Z"
observation["observedActivities"] = ["relay": [observedRow]]
observationEntries = [["timestamp": 0, "props": observation]]
assert(!AgentWidgetStorage.observe(json(observation), entries: observationEntries, in: defaults))
assert(defaults.string(forKey: "t3_agent_widget_local_observation") == json(observation))
assert(unchangedTimeline.isEqual(defaults.array(forKey: AgentWidgetStorage.timelineKey)!))
let newestObservation = try! JSONSerialization.jsonObject(with: Data(defaults.string(forKey: "t3_agent_widget_local_observation")!.utf8)) as! [String: Any]
let intermediateCompletion: [String: Any] = ["activeCount": 0, "totalCount": 1, "activities": [completedRow]]
let afterNewObservation = props(AgentWidgetState.timeline(aggregate: intermediateCompletion, environmentIds: ["relay"], localObservation: newestObservation, now: now)[0])
assert(afterNewObservation["activeCount"] as? Int == 1)
assert((afterNewObservation["activities"] as! [[String: Any]])[0]["phase"] as? String == "running")
print("Newer source observations survive intermediate relay completions without repainting unchanged timelines")

assert(AgentWidgetStorage.commit([["timestamp": 0, "props": ["activeCount": 0, "activities": [completedRow]]]], generation: AgentWidgetStorage.generation(in: defaults), in: defaults))
assert(AgentWidgetStorage.observe(json(observation), entries: observationEntries, in: defaults))
print("Foreground observations repair a changed native background timeline")

observation["expiresAt"] = 1_620_000
observationEntries = [["timestamp": 0, "props": observation], ["timestamp": 1_620_000, "props": ["isStale": true]]]
assert(AgentWidgetStorage.observe(json(observation), entries: observationEntries, in: defaults))
observation["expiresAt"] = 1_650_000
observationEntries[0]["props"] = observation
observationEntries[1]["timestamp"] = 1_650_000
assert(AgentWidgetStorage.observe(json(observation), entries: observationEntries, in: defaults))
assert((defaults.array(forKey: AgentWidgetStorage.timelineKey) as! [[String: Any]])[1]["timestamp"] as? Int == 1_650_000)
observationEntries[0]["timestamp"] = 10
assert(!AgentWidgetStorage.observe(json(observation), entries: observationEntries, in: defaults))
print("Future expiration shifts persist within a display minute; unchanged deadlines stay deduplicated")

defaults.set("https://retry-relay.test/v1/widget/agent-activity", forKey: "t3_agent_widget_url")
_ = AgentWidgetStorage.clearStoredState(in: defaults, readCredential: { .unavailable })
let signedOutGeneration = AgentWidgetStorage.generation(in: defaults)
let signedOut: [[String: Any]] = [["timestamp": 0, "props": ["isSignedOut": true, "activeCount": 0, "activities": [[String: Any]]()]]]
assert(AgentWidgetStorage.commit(signedOut, generation: signedOutGeneration, in: defaults))
AgentWidgetStorage.prepareRevocations(in: defaults, readCredential: { .unavailable })
assert(defaults.string(forKey: AgentWidgetStorage.generationKey) == signedOutGeneration)
assert(props((defaults.array(forKey: AgentWidgetStorage.timelineKey) as! [[String: Any]])[0])["isSignedOut"] as? Bool == true)
AgentWidgetStorage.prepareRevocations(in: defaults, readCredential: { .available("recovered-token") }, storeRevocation: { _ in true })
assert(defaults.string(forKey: "t3_agent_widget_url") == nil)
assert(defaults.string(forKey: AgentWidgetStorage.generationKey) == signedOutGeneration)
assert(props((defaults.array(forKey: AgentWidgetStorage.timelineKey) as! [[String: Any]])[0])["isSignedOut"] as? Bool == true)
print("Revocation retries preserve signed-out timeline ownership during secure failure and recovery")
