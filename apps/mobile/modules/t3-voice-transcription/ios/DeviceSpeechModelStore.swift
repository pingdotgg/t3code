import CryptoKit
import Foundation
import Synchronization

actor DeviceSpeechModelStore {
  enum State: Equatable, Sendable {
    case missing
    case downloading(percent: Int)
    case verifying
    case cancelling
    case ready
    case failed

    var payload: [String: Any] {
      switch self {
      case .missing: return ["kind": "missing"]
      case .downloading(let percent): return ["kind": "downloading", "percent": percent]
      case .verifying: return ["kind": "verifying"]
      case .cancelling: return ["kind": "cancelling"]
      case .ready: return ["kind": "ready"]
      case .failed: return ["kind": "failed"]
      }
    }
  }

  struct Snapshot: Sendable {
    let states: [String: State]
    let revision: Int

    var payload: [String: Any] {
      ["revision": revision, "states": states.mapValues(\.payload)]
    }
  }

  typealias Publish = @Sendable (Snapshot) -> Void

  private let directory = URL.applicationSupportDirectory.appending(
    path: "SpeechModels", directoryHint: .isDirectory)
  private func modelURL(_ model: DeviceSpeechModel) -> URL {
    directory.appending(path: "\(model.sha256).gguf")
  }
  private var download: (modelId: String, revision: Int, task: Task<Void, Never>)?
  private var inference: (modelId: String, id: String, cancellation: SpeechInferenceCancellation)?
  private var earlyCancellation: String?
  private var states: [String: State] = [:]
  private var revision = 0
  private var storagePrepared = false

  private var current: Snapshot { Snapshot(states: states, revision: revision) }

  private func model(_ id: String) throws -> DeviceSpeechModel {
    guard let model = DeviceSpeechCatalog.models.first(where: { $0.id == id }) else {
      throw CocoaError(.featureUnsupported)
    }
    return model
  }

  func snapshot(publish: Publish) -> Snapshot {
    prepareStorage()
    let previous = states
    for model in DeviceSpeechCatalog.models where model.id != download?.modelId {
      let ready = Self.isCompleteFile(modelURL(model), size: model.size)
      if ready || states[model.id] != .failed {
        states[model.id] = ready ? .ready : .missing
      }
    }
    if states != previous {
      revision += 1
      publish(current)
    }
    return current
  }

  func startDownload(_ modelId: String, publish: @escaping Publish) throws {
    let model = try model(modelId)
    guard model.canRun else { throw POSIXError(.ENOMEM) }
    guard download == nil, snapshot(publish: publish).states[modelId] != .ready else { return }
    setState(.downloading(percent: 0), for: modelId, publish: publish)
    let revision = revision
    download = (modelId, revision, Task { await install(model, revision: revision, publish: publish) })
  }

  func cancelDownload(_ modelId: String, publish: Publish) {
    guard let download, download.modelId == modelId else { return }
    setState(.cancelling, for: modelId, publish: publish)
    download.task.cancel()
  }

  func remove(_ modelId: String, publish: Publish) throws {
    guard download?.modelId != modelId, inference?.modelId != modelId else {
      throw CocoaError(.fileLocking)
    }
    let model = try model(modelId)
    try Self.removeIfPresent(modelURL(model))
    setState(.missing, for: modelId, publish: publish)
  }

  func prepareStorage() {
    guard !storagePrepared else { return }
    storagePrepared = true
    guard !DeviceSpeechCatalog.models.isEmpty else { return }
    if !FileManager.default.fileExists(atPath: directory.path) {
      let previous = URL.applicationSupportDirectory.appending(path: "ParakeetUltra")
      try? FileManager.default.moveItem(at: previous, to: directory)
    }
    guard let files = try? FileManager.default.contentsOfDirectory(
      at: directory, includingPropertiesForKeys: nil)
    else { return }
    let current = Set(DeviceSpeechCatalog.models.map { modelURL($0).lastPathComponent })
    for file in files where file.pathExtension == "gguf" && !current.contains(file.lastPathComponent) {
      try? Self.removeIfPresent(file)
    }
  }

  func stop() {
    download?.task.cancel()
    inference?.cancellation.cancel()
  }

  func transcribe(modelId: String, id: String, file: URL) async throws
    -> DeviceSpeechEngine.Transcript
  {
    if earlyCancellation == id {
      earlyCancellation = nil
      throw CancellationError()
    }
    guard inference == nil else { throw CocoaError(.fileLocking) }
    let model = try model(modelId)
    prepareStorage()
    guard Self.isCompleteFile(modelURL(model), size: model.size) else {
      throw CocoaError(.fileNoSuchFile)
    }
    guard model.canRun, model.fits(availableMemory: DeviceSpeechCatalog.availableMemory) else {
      throw POSIXError(.ENOMEM)
    }

    let cancellation = SpeechInferenceCancellation()
    inference = (modelId, id, cancellation)
    defer { inference = nil }
    let url = modelURL(model)
    return try await Task.detached(priority: .userInitiated) {
      try DeviceSpeechEngine.transcribe(file: file, model: url, cancellation: cancellation)
    }.value
  }

  func cancelInference(id: String) {
    if let inference, inference.id == id {
      inference.cancellation.cancel()
      return
    }
    // Expo can deliver the cancellation before the async transcription reaches the actor.
    earlyCancellation = id
  }

  private func install(_ model: DeviceSpeechModel, revision: Int, publish: @escaping Publish) async {
    let result: State
    do {
      var directory = directory
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try directory.setResourceValues(values)
      try Task.checkCancellation()

      let url = URL(
        string:
          "https://huggingface.co/\(model.id)/resolve/\(model.revision)/\(model.filename)"
      )!
      let progress = DownloadProgress(size: Int64(model.size)) { [weak self] percent in
        Task { await self?.reportProgress(percent, revision: revision, publish: publish) }
      }
      let session = URLSession(configuration: .ephemeral)
      defer { session.finishTasksAndInvalidate() }
      let (temporary, response) = try await session.download(from: url, delegate: progress)
      defer { try? Self.removeIfPresent(temporary) }
      try Task.checkCancellation()
      guard (response as? HTTPURLResponse)?.statusCode == 200,
        Self.isCompleteFile(temporary, size: model.size)
      else {
        throw CocoaError(.fileReadCorruptFile)
      }
      setState(.verifying, for: model.id, publish: publish)
      try await Self.verifyChecksum(temporary, sha256: model.sha256)
      try Task.checkCancellation()

      guard rename(temporary.path, modelURL(model).path) == 0 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
      result = .ready
    } catch {
      result = Task.isCancelled ? .missing : .failed
    }
    download = nil
    setState(result, for: model.id, publish: publish)
  }

  private func reportProgress(_ percent: Int, revision: Int, publish: Publish) {
    guard let download, download.revision == revision,
      case .downloading(let previous) = states[download.modelId],
      percent > previous
    else { return }
    setState(.downloading(percent: percent), for: download.modelId, publish: publish)
  }

  private func setState(_ next: State, for modelId: String, publish: Publish) {
    guard states[modelId] != next else { return }
    revision += 1
    states[modelId] = next
    publish(current)
  }

  private static func isCompleteFile(_ file: URL, size: Int) -> Bool {
    guard let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]) else {
      return false
    }
    return values.isRegularFile == true && values.fileSize == size
  }

  private static func removeIfPresent(_ url: URL) throws {
    do {
      try FileManager.default.removeItem(at: url)
    } catch let error as CocoaError where error.code == .fileNoSuchFile {
      return
    }
  }

  @concurrent
  private static func verifyChecksum(_ file: URL, sha256 expected: String) async throws {
    let handle = try FileHandle(forReadingFrom: file)
    defer { try? handle.close() }
    var sha256 = SHA256()
    while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty {
      try Task.checkCancellation()
      sha256.update(data: chunk)
    }
    guard sha256.finalize().map({ String(format: "%02x", $0) }).joined() == expected else {
      throw CocoaError(.fileReadCorruptFile)
    }
  }
}

private final class DownloadProgress: NSObject, URLSessionDownloadDelegate {
  let size: Int64
  let report: @Sendable (Int) -> Void
  private let percent = Mutex(0)

  init(size: Int64, report: @escaping @Sendable (Int) -> Void) {
    self.size = size
    self.report = report
  }

  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask,
    didFinishDownloadingTo location: URL
  ) {}

  func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64,
    totalBytesExpectedToWrite: Int64
  ) {
    guard totalBytesWritten <= size, totalBytesExpectedToWrite <= size else {
      downloadTask.cancel()
      return
    }
    let next = Int(totalBytesWritten * 100 / size)
    let changed = percent.withLock {
      guard next > $0 else { return false }
      $0 = next
      return true
    }
    if changed { report(next) }
  }
}
