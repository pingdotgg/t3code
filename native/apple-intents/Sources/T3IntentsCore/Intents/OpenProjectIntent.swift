import AppIntents
import Foundation

@available(iOS 27.3, macOS 27.3, *)
public struct OpenProjectIntent: OpenIntent, Sendable {
  public static let title: LocalizedStringResource = "Open Project"
  public static let description = IntentDescription(
    "Open a project in T3 Code to start a new thread.",
    categoryName: "Projects"
  )
  public static let supportedModes: IntentModes = .foreground

  @Parameter(
    title: "Project",
    description: "The T3 Code project to open."
  )
  public var target: ProjectEntity

  public static var parameterSummary: some ParameterSummary {
    Summary("Open \(\.$target)")
  }

  public init() {}

  public init(target: ProjectEntity) {
    self.target = target
  }

  @MainActor
  public func perform() async throws -> some IntentResult {
    var components = URLComponents()
    components.scheme = T3IntentsConfig.urlScheme
    components.host = "new"
    var items = [
      URLQueryItem(name: "environmentId", value: target.environmentId),
      URLQueryItem(name: "projectId", value: target.projectId),
    ]
    if let repo = target.repositoryIdentity, !repo.isEmpty {
      items.append(URLQueryItem(name: "repo", value: repo))
    }
    components.queryItems = items
    if let url = components.url {
      T3DeepLinkOpener.open(url)
    }
    return .result()
  }
}
