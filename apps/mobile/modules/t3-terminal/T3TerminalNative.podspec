require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'T3TerminalNative'
  s.version = package['version']
  s.summary = 'Native terminal surface for Hyakki mobile.'
  s.description = 'Native terminal surface bridge used by the Hyakki React Native app.'
  s.homepage = 'https://github.com/Ryoku-dev/hyakki'
  s.license = { :type => 'UNLICENSED' }
  s.author = { 'Hyakki' => 'hyakki@ryoku.dev' }
  s.platforms = { :ios => '16.1' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.vendored_frameworks = 'Vendor/libghostty/GhosttyKit.xcframework'
  # libghostty has no x86_64 simulator slice, so a simulator build for every
  # architecture (EAS's generic destination) fails to resolve GhosttyKit.
  s.pod_target_xcconfig = { 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'x86_64' }
  s.user_target_xcconfig = { 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'x86_64' }
  s.frameworks = 'IOSurface', 'Metal', 'MetalKit', 'QuartzCore', 'UIKit'
  s.libraries = 'c++', 'z'
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
end
