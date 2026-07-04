// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "SergeCodeMac",
    platforms: [
        .macOS("26.0")
    ],
    targets: [
        .target(
            name: "T3Kit",
            path: "Sources/T3Kit"
        ),
        .executableTarget(
            name: "SergeCodeMac",
            dependencies: ["T3Kit"],
            path: "Sources/SergeCodeMac"
        ),
        .testTarget(
            name: "T3KitTests",
            dependencies: ["T3Kit"],
            path: "Tests/T3KitTests"
        ),
    ]
)
