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
        .target(
            name: "SidecarKit",
            path: "Sources/SidecarKit"
        ),
        .executableTarget(
            name: "SergeCodeMac",
            dependencies: ["T3Kit", "SidecarKit"],
            path: "Sources/SergeCodeMac"
        ),
        .testTarget(
            name: "T3KitTests",
            dependencies: ["T3Kit"],
            path: "Tests/T3KitTests"
        ),
        .testTarget(
            name: "SidecarKitTests",
            dependencies: ["SidecarKit"],
            path: "Tests/SidecarKitTests"
        ),
    ]
)
