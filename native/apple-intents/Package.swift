// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "T3IntentsCore",
  defaultLocalization: "en",
  platforms: [
    .iOS(.v17),
    .macOS(.v15),
  ],
  products: [
    .library(
      name: "T3IntentsCore",
      targets: ["T3IntentsCore"]
    ),
  ],
  targets: [
    .target(
      name: "T3IntentsCore",
      path: "Sources/T3IntentsCore",
      linkerSettings: [
        .linkedLibrary("sqlite3"),
      ]
    ),
    .testTarget(
      name: "T3IntentsCoreTests",
      dependencies: ["T3IntentsCore"],
      path: "Tests/T3IntentsCoreTests"
    ),
  ]
)
