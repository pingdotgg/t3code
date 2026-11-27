import CTranscribe
import Foundation
import os

struct DeviceSpeechModel: Decodable, Sendable {
  struct Accuracy: Decodable, Sendable {
    let grade: String
    let errorPercent: Double
  }

  struct Benchmark: Decodable, Sendable {
    let accuracy: [String: Accuracy]
  }

  let id: String
  let name: String
  let description: String
  let languages: [String]
  let revision: String
  let filename: String
  let size: Int
  let sha256: String
  let benchmark: Benchmark

  var canRun: Bool { fits(availableMemory: DeviceSpeechCatalog.launchMemoryBudget) }

  var payload: [String: Any] {
    [
      "id": id, "name": name, "description": description, "languages": languages, "size": size,
      "canRun": canRun,
      "benchmark": [
        "accuracy": benchmark.accuracy.mapValues { ["grade": $0.grade, "errorPercent": $0.errorPercent] },
        "secondsPer30s": ["accelerated": NSNull()],
      ],
    ]
  }

  func fits(availableMemory: Int) -> Bool {
    // Budget for another copy of the weights and graph/audio buffers.
    let buffers = 512 * 1024 * 1024
    return size > 0 && availableMemory >= buffers && size <= (availableMemory - buffers) / 2
  }
}

enum DeviceSpeechCatalog {
  private struct Manifest: Decodable {
    let engineVersion: String
    let models: [DeviceSpeechModel]
  }

  static let models: [DeviceSpeechModel] = {
    guard let resources = Bundle.main.url(forResource: "T3SpeechModels", withExtension: "bundle"),
      let url = Bundle(url: resources)?.url(forResource: "catalog", withExtension: "json"),
      let data = try? Data(contentsOf: url),
      let catalog = try? JSONDecoder().decode(Manifest.self, from: data),
      let version = transcribe_version(), catalog.engineVersion == String(cString: version)
    else { return [] }
    return catalog.models
  }()

  static let launchMemoryBudget = availableMemory

  static var availableMemory: Int {
    #if os(iOS) && !targetEnvironment(simulator)
      Int(clamping: os_proc_available_memory())
    #else
      Int(clamping: ProcessInfo.processInfo.physicalMemory)
    #endif
  }
}
