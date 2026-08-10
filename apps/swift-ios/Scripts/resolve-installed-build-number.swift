import Foundation

private struct InstalledApps: Decodable {
    struct Result: Decodable {
        struct App: Decodable {
            let bundleIdentifier: String
            let bundleVersion: String?
        }

        let apps: [App]
    }

    let result: Result
}

guard CommandLine.arguments.count == 3 else {
    FileHandle.standardError.write(
        Data("usage: resolve-installed-build-number <apps.json> <bundle-identifier>\n".utf8)
    )
    exit(64)
}

do {
    let payload = try JSONDecoder().decode(
        InstalledApps.self,
        from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    )
    let bundleIdentifier = CommandLine.arguments[2]
    if let version = payload.result.apps.first(where: {
        $0.bundleIdentifier == bundleIdentifier
    })?.bundleVersion {
        print(version)
    }
} catch {
    FileHandle.standardError.write(
        Data("Could not read installed app build number: \(error.localizedDescription)\n".utf8)
    )
    exit(1)
}
