// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "T3Mobile",
    platforms: [
        .iOS(.v26),
        .macOS(.v14),
    ],
    products: [
        .library(
            name: "T3MobileProtocol",
            targets: ["T3MobileProtocol"]
        ),
    ],
    targets: [
        .target(name: "T3MobileProtocol"),
        .testTarget(
            name: "T3MobileProtocolTests",
            dependencies: ["T3MobileProtocol"]
        ),
    ]
)
