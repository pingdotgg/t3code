import Foundation

enum FeatureBoundedDataLoaderError: Error, Equatable {
    case tooLarge
}

/// Bridges URLSession's incremental delegate callbacks into one bounded async load.
/// All mutable delegate state is protected by `lock`, including terminal completion.
final class FeatureBoundedDataLoader: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private struct Output {
        let data: Data
        let response: URLResponse
    }

    private let maximumBytes: Int
    private let configuration: URLSessionConfiguration
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Output, any Error>?
    private var task: URLSessionDataTask?
    private var response: URLResponse?
    private var buffer = Data()
    private var cancellationRequested = false

    private lazy var session = URLSession(
        configuration: configuration,
        delegate: self,
        delegateQueue: nil
    )

    private init(maximumBytes: Int, configuration: URLSessionConfiguration) {
        self.maximumBytes = maximumBytes
        self.configuration = configuration
    }

    static func data(
        from url: URL,
        maximumBytes: Int,
        configuration: URLSessionConfiguration = .ephemeral
    ) async throws -> (Data, URLResponse) {
        guard maximumBytes >= 0 else { throw FeatureBoundedDataLoaderError.tooLarge }
        let loader = FeatureBoundedDataLoader(
            maximumBytes: maximumBytes,
            configuration: configuration
        )
        let output = try await loader.load(from: url)
        return (output.data, output.response)
    }

    private func load(from url: URL) async throws -> Output {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                start(url: url, continuation: continuation)
            }
        } onCancel: {
            cancel()
        }
    }

    private func start(
        url: URL,
        continuation: CheckedContinuation<Output, any Error>
    ) {
        lock.lock()
        if cancellationRequested {
            lock.unlock()
            continuation.resume(throwing: CancellationError())
            return
        }
        self.continuation = continuation
        let task = session.dataTask(with: url)
        self.task = task
        lock.unlock()
        task.resume()
    }

    private func cancel() {
        lock.lock()
        cancellationRequested = true
        lock.unlock()
        finish(.failure(CancellationError()), cancellingTask: true)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
    ) {
        if response.expectedContentLength > Int64(maximumBytes) {
            completionHandler(.cancel)
            finish(.failure(FeatureBoundedDataLoaderError.tooLarge))
            return
        }

        lock.lock()
        let isActive = continuation != nil
        if isActive { self.response = response }
        lock.unlock()
        completionHandler(isActive ? .allow : .cancel)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive data: Data
    ) {
        lock.lock()
        guard continuation != nil else {
            lock.unlock()
            return
        }
        guard data.count <= maximumBytes - buffer.count else {
            lock.unlock()
            finish(.failure(FeatureBoundedDataLoaderError.tooLarge), cancellingTask: true)
            return
        }
        buffer.append(data)
        lock.unlock()
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: (any Error)?
    ) {
        if let error {
            finish(.failure(error))
            return
        }

        lock.lock()
        let output = response.map { Output(data: buffer, response: $0) }
        lock.unlock()
        if let output {
            finish(.success(output))
        } else {
            finish(.failure(URLError(.badServerResponse)))
        }
    }

    private func finish(
        _ result: Result<Output, any Error>,
        cancellingTask: Bool = false
    ) {
        lock.lock()
        guard let continuation else {
            lock.unlock()
            return
        }
        self.continuation = nil
        let task = self.task
        self.task = nil
        lock.unlock()

        if cancellingTask { task?.cancel() }
        session.finishTasksAndInvalidate()
        continuation.resume(with: result)
    }
}
