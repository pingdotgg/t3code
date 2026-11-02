Pod::Spec.new do |s|
  s.name = 'T3LanDiscovery'
  s.version = '0.0.0'
  s.summary = 'LAN discovery for T3 Code mobile.'
  s.description = 'Discovers local T3 Code services using Bonjour.'
  s.author = 'T3 Tools'
  s.homepage = 'https://t3tools.com'
  s.platforms = { :ios => '16.4' }
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = 'ios/**/*.swift'
end
