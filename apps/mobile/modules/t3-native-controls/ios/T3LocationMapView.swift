import ExpoModulesCore
import MapKit
import UIKit

/// A single MapKit snapshot of a message attachment, with no device-location tracking.
final class T3LocationMapView: ExpoView {
  let onStatusChange = EventDispatcher()
  var latitude: Double? { didSet { setNeedsLayout() } }
  var longitude: Double? { didSet { setNeedsLayout() } }
  var appearance = "light" { didSet { setNeedsLayout() } }

  private struct Request: Equatable {
    let latitude: Double
    let longitude: Double
    let size: CGSize
    let appearance: String
  }

  private let imageView = UIImageView()
  private let markerView = UIImageView()
  private var snapshotter: MKMapSnapshotter?
  private var request: Request?
  private var revision = 0

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    accessibilityElementsHidden = true
    clipsToBounds = true
    imageView.contentMode = .scaleAspectFill
    addSubview(imageView)
    markerView.image = UIImage(
      systemName: "mappin.circle.fill",
      withConfiguration: UIImage.SymbolConfiguration(pointSize: 30, weight: .medium)
    )?.applyingSymbolConfiguration(UIImage.SymbolConfiguration(paletteColors: [.white, .systemBlue]))
    markerView.isHidden = true
    addSubview(markerView)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      revision += 1
      snapshotter?.cancel()
      snapshotter = nil
      request = nil
    } else {
      setNeedsLayout()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    imageView.frame = bounds
    guard window != nil, bounds.width > 0, bounds.height > 0,
          let latitude, let longitude else { return }
    let coordinate = CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    guard CLLocationCoordinate2DIsValid(coordinate), abs(latitude) <= 85 else {
      onStatusChange(["status": "error"])
      return
    }
    let next = Request(latitude: latitude, longitude: longitude, size: bounds.size, appearance: appearance)
    guard next != request else { return }
    snapshotter?.cancel()
    request = next
    revision += 1
    let revision = revision
    imageView.image = nil
    markerView.isHidden = true
    onStatusChange(["status": "loading"])

    let options = MKMapSnapshotter.Options()
    options.region = MKCoordinateRegion(center: coordinate, latitudinalMeters: 700, longitudinalMeters: 1100)
    options.size = bounds.size
    options.traitCollection = UITraitCollection(traitsFrom: [
      traitCollection,
      UITraitCollection(userInterfaceStyle: appearance == "dark" ? .dark : .light),
    ])
    options.preferredConfiguration = MKStandardMapConfiguration(elevationStyle: .flat)
    let snapshotter = MKMapSnapshotter(options: options)
    self.snapshotter = snapshotter
    snapshotter.start(with: .main) { [weak self] snapshot, _ in
      guard let self, self.window != nil, self.revision == revision else { return }
      self.snapshotter = nil
      guard let snapshot else {
        self.onStatusChange(["status": "error"])
        return
      }
      self.imageView.image = snapshot.image
      let point = snapshot.point(for: coordinate)
      self.markerView.frame = CGRect(x: point.x - 15, y: point.y - 30, width: 30, height: 30)
      self.markerView.isHidden = false
      self.onStatusChange(["status": "ready"])
    }
  }
}
