import CryptoKit
import Foundation
import Synchronization

actor ParakeetUltraModel {
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
    let state: State
    let revision: Int

    var payload: [String: Any] {
      ["revision": revision, "state": state.payload]
    }
  }

  typealias Publish = @Sendable (Snapshot) -> Void

  private let directory = URL.applicationSupportDirectory.appending(
    path: "ParakeetUltra", directoryHint: .isDirectory)
  private var checksumAddressedModelURL: URL {
    directory.appending(path: "\(ParakeetUltraArtifact.sha256).gguf")
  }
  private var download: (id: Int, task: Task<Void, Never>)?
  private var inference: (id: String, cancellation: ParakeetUltraCancellation)?
  private var earlyCancellation: String?
  private var state: State = .missing
  private var revision = 0

  func snapshot(publish: Publish) -> Snapshot {
    if download == nil {
      let ready = Self.isCompleteFile(checksumAddressedModelURL)
      if ready || state != .failed {
        setState(ready ? .ready : .missing, publish: publish)
      }
    }
    return Snapshot(state: state, revision: revision)
  }

  func startDownload(publish: @escaping Publish) {
    guard download == nil, snapshot(publish: publish).state != .ready else { return }
    pruneSupersededModels()
    setState(.downloading(percent: 0), publish: publish)
    let id = revision
    download = (id, Task { await install(downloadId: id, publish: publish) })
  }

  func cancelDownload(publish: Publish) {
    guard let download else { return }
    setState(.cancelling, publish: publish)
    download.task.cancel()
  }

  func remove(publish: Publish) throws {
    guard download == nil, inference == nil else { throw CocoaError(.fileLocking) }
    try Self.removeIfPresent(directory)
    setState(.missing, publish: publish)
  }

  func pruneSupersededModels() {
    guard let files = try? FileManager.default.contentsOfDirectory(
      at: directory, includingPropertiesForKeys: nil)
    else { return }
    let current = checksumAddressedModelURL.lastPathComponent
    for file in files where file.pathExtension == "gguf" && file.lastPathComponent != current {
      try? Self.removeIfPresent(file)
    }
  }

  func stop() {
    download?.task.cancel()
    inference?.cancellation.cancel()
  }

  func transcribe(id: String, file: URL, publish: Publish) async throws -> String {
    if earlyCancellation == id {
      earlyCancellation = nil
      throw CancellationError()
    }
    guard inference == nil else { throw CocoaError(.fileLocking) }
    guard snapshot(publish: publish).state == .ready else { throw CocoaError(.fileNoSuchFile) }

    let cancellation = ParakeetUltraCancellation()
    inference = (id, cancellation)
    defer { inference = nil }
    let model = checksumAddressedModelURL
    return try await Task.detached(priority: .userInitiated) {
      try ParakeetUltraEngine.transcribe(file: file, model: model, cancellation: cancellation)
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

  private func install(downloadId: Int, publish: @escaping Publish) async {
    let result: State
    do {
      var directory = directory
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try directory.setResourceValues(values)
      try Task.checkCancellation()

      let artifact = ParakeetUltraArtifact.self
      let url = URL(
        string:
          "https://huggingface.co/\(artifact.repository)/resolve/\(artifact.revision)/\(artifact.filename)"
      )!
      let progress = DownloadProgress { [weak self] percent in
        Task { await self?.reportProgress(percent, downloadId: downloadId, publish: publish) }
      }
      let session = URLSession(configuration: .ephemeral)
      defer { session.finishTasksAndInvalidate() }
      let (temporary, response) = try await session.download(from: url, delegate: progress)
      defer { try? Self.removeIfPresent(temporary) }
      try Task.checkCancellation()
      guard (response as? HTTPURLResponse)?.statusCode == 200, Self.isCompleteFile(temporary) else {
        throw CocoaError(.fileReadCorruptFile)
      }
      setState(.verifying, publish: publish)
      try await Self.verifyChecksum(temporary)
      try Task.checkCancellation()

      guard rename(temporary.path, checksumAddressedModelURL.path) == 0 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
      result = .ready
    } catch {
      result = Task.isCancelled ? .missing : .failed
    }
    download = nil
    setState(result, publish: publish)
  }

  private func reportProgress(_ percent: Int, downloadId: Int, publish: Publish) {
    guard download?.id == downloadId, case .downloading(let previous) = state,
      percent > previous
    else { return }
    setState(.downloading(percent: percent), publish: publish)
  }

  private func setState(_ next: State, publish: Publish) {
    guard state != next else { return }
    revision += 1
    state = next
    publish(Snapshot(state: next, revision: revision))
  }

  private static func isCompleteFile(_ file: URL) -> Bool {
    guard let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]) else {
      return false
    }
    return values.isRegularFile == true && values.fileSize == ParakeetUltraArtifact.byteCount
  }

  private static func removeIfPresent(_ url: URL) throws {
    do {
      try FileManager.default.removeItem(at: url)
    } catch let error as CocoaError where error.code == .fileNoSuchFile {
      return
    }
  }

  @concurrent
  private static func verifyChecksum(_ file: URL) async throws {
    let handle = try FileHandle(forReadingFrom: file)
    defer { try? handle.close() }
    var sha256 = SHA256()
    while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty {
      try Task.checkCancellation()
      sha256.update(data: chunk)
    }
    guard
      sha256.finalize().map({ String(format: "%02x", $0) }).joined() == ParakeetUltraArtifact.sha256
    else {
      throw CocoaError(.fileReadCorruptFile)
    }
  }
}

private final class DownloadProgress: NSObject, URLSessionDownloadDelegate {
  let report: @Sendable (Int) -> Void
  private let percent = Mutex(0)

  init(report: @escaping @Sendable (Int) -> Void) {
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
    let size = Int64(ParakeetUltraArtifact.byteCount)
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
