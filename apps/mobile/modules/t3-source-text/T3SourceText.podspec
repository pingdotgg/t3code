require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))
new_arch_enabled = ENV["RCT_NEW_ARCH_ENABLED"] == "1"

Pod::Spec.new do |s|
  s.name = "T3SourceText"
  s.version = package["version"]
  s.summary = "Native selectable source text for Hyakki mobile."
  s.description = "Fabric-backed styled source text with whole-document selection."
  s.homepage = "https://github.com/Ryoku-dev/hyakki"
  s.license = { :type => "MIT", :file => "LICENSE" }
  s.author = { "Hyakki" => "hyakki@ryoku.dev" }
  s.platforms = { :ios => min_ios_version_supported }
  s.source = { :path => "." }
  s.source_files = "ios/**/*.{h,m,mm,cpp}"

  install_modules_dependencies(s)

  if ENV["USE_FRAMEWORKS"] != nil && new_arch_enabled
    add_dependency(s, "React-FabricComponents", :additional_framework_paths => [
      "react/renderer/textlayoutmanager/platform/ios",
    ])
  end
end
