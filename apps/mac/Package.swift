// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "SergeCodeMac",
    platforms: [
        .macOS("26.0")
    ],
    dependencies: [
        // Local ASR (Parakeet TDT v3 CoreML) for the dictation feature — the
        // app's external dependencies.
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.15.0"),
        .package(url: "https://github.com/swiftlang/swift-markdown.git", from: "0.5.0")
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
                .product(name: "Markdown", package: "swift-markdown"),
            ],
            path: "Sources/SergeCodeMac",
            exclude: ["Vendor/HighlightSwift/LICENSE.md"],
            resources: [.process("Vendor/HighlightSwift/HighlightJS")]
        ),
        .testTarget(
            name: "SergeCodeMacTests",
            dependencies: ["SergeCodeMac"],
            path: "Tests/SergeCodeMacTests"
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
