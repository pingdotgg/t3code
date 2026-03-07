cask "t3code" do
  version "0.0.3"

  on_arm do
    url "https://github.com/pingdotgg/t3code/releases/download/v#{version}/T3-Code-#{version}-arm64.dmg"
    sha256 "d3104279b1194532bbeab917063ef2f04e7b91e1b48456c3fdbe1868bcdd80f8"
  end

  on_intel do
    url "https://github.com/pingdotgg/t3code/releases/download/v#{version}/T3-Code-#{version}-x64.dmg"
    sha256 "ef27751ffadc5fa8e90aed2f873e913931e6ddfeb3665a8faaac9887d4b4b9ea"
  end

  name "T3 Code"
  desc "A minimal desktop GUI for coding agents"
  homepage "https://t3.codes"

  livecheck do
    url "https://github.com/pingdotgg/t3code/releases/latest"
    strategy :github_latest
  end

  app "T3 Code.app"

  caveats <<~EOS
    T3 Code requires Codex CLI to be installed and authorized separately.
    Install it with:
      npm install -g @openai/codex
    Then authorize it before launching T3 Code.
    See: https://github.com/openai/codex
  EOS
end
