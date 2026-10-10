import Foundation
import WidgetKit
import SwiftUI
internal import ExpoWidgets

// Fetch from the widget extension, not the suspended app's JS runtime. The
// capability can only read this install's owner's linked agent activity.
struct AgentWidgetTimelineProvider: TimelineProvider {
  typealias Entry = WidgetsTimelineEntry
  private let cached = WidgetsTimelineProvider(name: "AgentActivity")

  func placeholder(in context: Context) -> Entry { cached.placeholder(in: context) }
  func getSnapshot(in context: Context, completion: @escaping @Sendable (Entry) -> Void) {
    cached.getTimeline(in: context) { timeline in
      completion(timeline.entries.last(where: { $0.date <= Date() }) ?? cached.placeholder(in: context))
    }
  }

  func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<Entry>) -> Void) {
    AgentWidgetNetwork.refresh { _ in
      cached.getTimeline(in: context) { timeline in
        // Ask for another read even if no agent state changes. WidgetKit controls
        // the actual schedule; pushes complement this, they don't replace it.
        completion(Timeline(entries: timeline.entries, policy: .after(Date().addingTimeInterval(5 * 60))))
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
    guard let defaults, let rawURL = defaults.string(forKey: "t3_agent_widget_url"),
          let token = AgentWidgetCredential.read(),
          var components = URLComponents(string: rawURL) else { completion(false); return }
    if let pushToken = defaults.string(forKey: "t3_agent_widget_push_token") {
      components.queryItems = [URLQueryItem(name: "pushToken", value: pushToken)]
    }
    guard let url = components.url else { completion(false); return }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    URLSession.shared.dataTask(with: request) { data, response, _ in
      // Sign-out / another account's configuration wins over an in-flight read.
      guard AgentWidgetCredential.read() == token,
            defaults.string(forKey: "t3_agent_widget_url") == rawURL else { completion(false); return }
      guard let http = response as? HTTPURLResponse, http.statusCode == 200,
            let data, let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            body.keys.contains("aggregate") else { completion(false); return }
      let aggregate = body["aggregate"] as? [String: Any]
      guard aggregate != nil || body["aggregate"] is NSNull else { completion(false); return }
      let localObservation = defaults.string(forKey: "t3_agent_widget_local_observation").flatMap {
        $0.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      }
      let environmentIds = body["environmentIds"] as? [String] ?? (aggregate?["activities"] as? [[String: Any]] ?? []).compactMap { $0["environmentId"] as? String }
      defaults.set(AgentWidgetState.timeline(aggregate: aggregate, environmentIds: environmentIds,
        localObservation: localObservation, now: Date()), forKey: "__expo_widgets_AgentActivity_timeline")
      completion(true)
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
