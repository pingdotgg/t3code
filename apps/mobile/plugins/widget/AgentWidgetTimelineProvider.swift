import Foundation
import WidgetKit
import SwiftUI
internal import ExpoWidgets

// Fetch from the widget extension, not the suspended app's JS runtime. The
// capability can only read this install's owner's linked agent activity.
struct AgentWidgetTimelineProvider: TimelineProvider {
  struct Entry: TimelineEntry {
    let cached: WidgetsTimelineEntry
    var date: Date { cached.date }
  }
  private let cached = WidgetsTimelineProvider(name: "AgentActivity")

  func placeholder(in context: Context) -> Entry { Entry(cached: cached.placeholder(in: context)) }
  func getSnapshot(in context: Context, completion: @escaping @Sendable (Entry) -> Void) {
    cached.getTimeline(in: context) { timeline in
      let entry = timeline.entries.last(where: { entry in
        entry.date <= Date() && AgentWidgetStorage.withLock { AgentWidgetStorage.owns(entry.props, in: $0) } == true
      })
      completion(entry.map { Entry(cached: $0) } ?? placeholder(in: context))
    }
  }

  func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<Entry>) -> Void) {
    AgentWidgetNetwork.refresh { _ in
      cached.getTimeline(in: context) { timeline in
        let entries = timeline.entries.filter { entry in
          AgentWidgetStorage.withLock { AgentWidgetStorage.owns(entry.props, in: $0) } == true
        }.map { Entry(cached: $0) }
        // Ask for another read even if no agent state changes. WidgetKit controls
        // the actual schedule; pushes complement this, they don't replace it.
        completion(Timeline(entries: entries.isEmpty ? [placeholder(in: context)] : entries,
          policy: .after(Date().addingTimeInterval(5 * 60))))
      }
    }
  }
}

struct AgentWidgetEntryView: View {
  let entry: AgentWidgetTimelineProvider.Entry

  var body: some View {
    // WidgetKit may retain an entry already handed out before account cleanup.
    if AgentWidgetStorage.withLock({ AgentWidgetStorage.owns(entry.cached.props, in: $0) }) == true {
      WidgetsEntryView(entry: entry.cached)
    } else {
      ZStack {
        EmptyWidgetView()
        VStack(alignment: .leading, spacing: 4) {
          Text("T3 Code").font(.headline)
          Text("Open T3 to refresh").font(.caption).foregroundStyle(.secondary)
        }
        .padding()
      }
    }
  }
}

enum AgentWidgetNetwork {
  static var defaults: UserDefaults? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "ExpoWidgetsAppGroupIdentifier") as? String else { return nil }
    return UserDefaults(suiteName: group)
  }

  static func refresh(completion: @escaping @Sendable (Bool) -> Void) {
    AgentWidgetStorage.retryRevocations()
    let configuration = AgentWidgetStorage.withLock { defaults -> (String, String, String, String?)? in
      guard defaults.string(forKey: "t3_agent_widget_identity") != nil,
            let rawURL = defaults.string(forKey: "t3_agent_widget_url"),
            let token = AgentWidgetCredential.read() else { return nil }
      return (rawURL, token, AgentWidgetStorage.generation(in: defaults), defaults.string(forKey: "t3_agent_widget_push_token"))
    }.flatMap { $0 }
    guard let (rawURL, token, generation, pushToken) = configuration,
          var components = URLComponents(string: rawURL) else { completion(false); return }
    if let pushToken {
      components.queryItems = [URLQueryItem(name: "pushToken", value: pushToken)]
    }
    guard let url = components.url else { completion(false); return }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    URLSession.shared.dataTask(with: request) { data, response, _ in
      guard let http = response as? HTTPURLResponse, http.statusCode == 200,
            let data, let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            body.keys.contains("aggregate") else { completion(false); return }
      let aggregate = body["aggregate"] as? [String: Any]
      guard aggregate != nil || body["aggregate"] is NSNull else { completion(false); return }
      let stored = AgentWidgetStorage.withLock { defaults in
        guard AgentWidgetCredential.read() == token,
              defaults.string(forKey: "t3_agent_widget_url") == rawURL,
              defaults.string(forKey: AgentWidgetStorage.generationKey) == generation else { return false }
        let localObservation = defaults.string(forKey: "t3_agent_widget_local_observation").flatMap {
          $0.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        }
        let environmentIds = body["environmentIds"] as? [String] ?? (aggregate?["activities"] as? [[String: Any]] ?? []).compactMap { $0["environmentId"] as? String }
        return AgentWidgetStorage.commit(AgentWidgetState.timeline(aggregate: aggregate, environmentIds: environmentIds,
          localObservation: localObservation, now: Date()), generation: generation, in: defaults)
      } ?? false
      completion(stored)
    }.resume()
  }
}

@available(iOS 26.0, *)
struct AgentWidgetPushHandler: WidgetPushHandler {
  func pushTokenDidChange(_ pushInfo: WidgetPushInfo, widgets: [WidgetInfo]) {
    let token = widgets.isEmpty ? "" : pushInfo.token.map { String(format: "%02x", $0) }.joined()
    AgentWidgetNetwork.defaults?.set(token, forKey: "t3_agent_widget_push_token")
    AgentWidgetNetwork.refresh { _ in WidgetCenter.shared.reloadTimelines(ofKind: "AgentActivity") }
  }
}

extension WidgetConfiguration {
  func agentWidgetPushHandler() -> some WidgetConfiguration {
    if #available(iOS 26.0, *) { return self.pushHandler(AgentWidgetPushHandler.self) }
    else { return self }
  }
}
