import SwiftUI

struct MobileSetupInstructionsView: View {
    var body: some View {
        ContentUnavailableView {
            Label("Mobile Setup Required", systemImage: "iphone.and.arrow.forward")
        } description: {
            VStack(alignment: .leading, spacing: 10) {
                Text("Pair this iPhone with the T3 Code server running on your Mac. Once pairing succeeds, T3 Mobile stores the session token in Keychain.")

                Text("On your Mac")
                    .font(.headline)
                Text("From this repo, run `bun apps/server/src/bin.ts auth pairing create --label \"iPhone\"`. If you installed the packaged CLI, `t3 auth pairing create --label \"iPhone\"` works too.")
                    .textSelection(.enabled)

                Text("On this iPhone")
                    .font(.headline)
                Text("Open Connection, enter the server URL, and paste the one-time pairing token.")
                    .textSelection(.enabled)
            }
            .font(.callout)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: 520, alignment: .leading)
        }
    }
}

#Preview {
    MobileSetupInstructionsView()
}
