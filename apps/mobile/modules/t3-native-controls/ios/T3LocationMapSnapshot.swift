import MapKit
import UIKit

/// Generates an in-memory map image; the React Native image component owns display.
final class T3LocationMapSnapshot {
  private let snapshotter: MKMapSnapshotter
  private let coordinate: CLLocationCoordinate2D
  private let size: CGSize
  private var completion: ((Result<String, Error>) -> Void)?
  private var timeout: DispatchWorkItem?

  init(latitude: Double, longitude: Double, width: Double, appearance: String,
       completion: @escaping (Result<String, Error>) -> Void) throws {
    let coordinate = CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    guard CLLocationCoordinate2DIsValid(coordinate), abs(latitude) <= 85,
          width.isFinite, width >= 1, width <= 1024 else {
      throw Self.error("This location cannot be previewed.")
    }
    self.coordinate = coordinate
    let size = CGSize(width: width, height: 160)
    self.size = size
    self.completion = completion
    let options = MKMapSnapshotter.Options()
    options.region = MKCoordinateRegion(center: coordinate, latitudinalMeters: 700, longitudinalMeters: 1100)
    options.size = size
    options.scale = 3
    options.traitCollection = UITraitCollection(userInterfaceStyle: appearance == "dark" ? .dark : .light)
    options.preferredConfiguration = MKStandardMapConfiguration(elevationStyle: .flat)
    snapshotter = MKMapSnapshotter(options: options)
  }

  func start() {
    let timeout = DispatchWorkItem { [weak self] in
      self?.cancel(message: "The map preview timed out.")
    }
    self.timeout = timeout
    DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: timeout)
    snapshotter.start(with: .main) { [weak self] snapshot, error in
      guard let self, self.completion != nil else { return }
      guard let snapshot, snapshot.image.cgImage != nil else {
        self.finish(.failure(error ?? Self.error("The map preview is unavailable.")))
        return
      }
      let point = snapshot.point(for: self.coordinate)
      guard point.x.isFinite, point.y.isFinite else {
        self.finish(.failure(Self.error("The map preview is unavailable.")))
        return
      }
      let format = UIGraphicsImageRendererFormat()
      format.scale = 3
      format.opaque = true
      let image = UIGraphicsImageRenderer(size: self.size, format: format).image { _ in
        snapshot.image.draw(in: CGRect(origin: .zero, size: self.size))
        let marker = UIImage(systemName: "mappin.circle.fill",
                             withConfiguration: UIImage.SymbolConfiguration(pointSize: 30, weight: .medium))?
          .applyingSymbolConfiguration(UIImage.SymbolConfiguration(paletteColors: [.white, .systemBlue]))
        marker?.draw(in: CGRect(x: point.x - 15, y: point.y - 30, width: 30, height: 30))
      }
      guard let data = image.pngData() else {
        self.finish(.failure(Self.error("The map preview is unavailable.")))
        return
      }
      self.finish(.success("data:image/png;base64," + data.base64EncodedString()))
    }
  }

  func cancel(message: String = "The map preview was cancelled.") {
    guard completion != nil else { return }
    snapshotter.cancel()
    finish(.failure(Self.error(message)))
  }

  private func finish(_ result: Result<String, Error>) {
    let completion = self.completion
    self.completion = nil
    timeout?.cancel()
    timeout = nil
    completion?(result)
  }

  private static func error(_ message: String) -> NSError {
    NSError(domain: "T3LocationMapSnapshot", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}
