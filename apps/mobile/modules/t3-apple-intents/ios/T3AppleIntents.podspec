Pod::Spec.new do |s|
  s.name = 'T3AppleIntents'
  s.version = '1.0.0'
  s.summary = 'iOS 27.3 Siri App Intents, Spotlight indexing, and onscreen entity bridge for T3 Code.'
  s.author = 'T3 Tools'
  s.homepage = 'https://t3tools.com'
  s.platforms = {
    :ios => '17.0',
  }
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift', 'Core/**/*.swift'
  s.frameworks = 'AppIntents', 'CoreSpotlight', 'SwiftUI', 'CryptoKit', 'Security'
  s.library = 'sqlite3'
  s.pod_target_xcconfig = {
    'SWIFT_VERSION' => '6.0',
    'DEFINES_MODULE' => 'YES',
  }
end
