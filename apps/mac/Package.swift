// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "SergeCodeMac",
    platforms: [
        .macOS("26.0")
    ],
    dependencies: [
        // Local ASR (Parakeet TDT v3 CoreML) for the dictation feature — the
        // app's only external dependency; coordinate before adding more.
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.15.0")
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
            dependencies: [
                "T3Kit",
                "SidecarKit",
                .product(name: "FluidAudio", package: "FluidAudio"),
            ],
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
