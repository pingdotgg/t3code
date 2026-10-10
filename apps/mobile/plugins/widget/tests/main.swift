import Foundation

let now = Date(timeIntervalSince1970: 1000)
func row(_ environmentId: String, _ phase: String) -> [String: Any] {
  ["environmentId": environmentId, "phase": phase, "status": phase, "threadTitle": "Test agent"]
}
func props(_ entry: [String: Any]) -> [String: Any] { entry["props"] as! [String: Any] }
let running: [String: Any] = ["activeCount": 1, "updatedAt": "old unchanged observation", "activities": [row("relay", "running")]]
let local: [String: Any] = ["expiresAt": now.addingTimeInterval(600).timeIntervalSince1970 * 1000,
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
let revocation = T3AgentWidgetConfiguration.clearStoredState(in: defaults)
assert(revocation?.httpMethod == "DELETE")
assert(revocation?.url?.absoluteString == "https://relay.test/v1/widget/agent-activity")
assert(revocation?.value(forHTTPHeaderField: "Authorization") == "Bearer test-capability")
for key in ["t3_agent_widget_identity", "t3_agent_widget_token", "t3_agent_widget_url", "t3_agent_widget_local_observation", "__expo_widgets_AgentActivity_timeline"] {
  assert(defaults.object(forKey: key) == nil)
}
assert(defaults.string(forKey: "t3_agent_widget_push_token") == "install-push-token")
assert(T3AgentWidgetConfiguration.clearStoredState(in: defaults) == nil)
print("Agent widget sign-out: cached rows removed and previous capability revocation prepared")
