Pod::Spec.new do |s|
  s.name = 'T3VoiceAudioSession'
  s.version = '1.0.0'
  s.summary = 'Foreground voice audio lifecycle events for T3 Code mobile.'
  s.description = 'Observes foreground WebRTC audio interruptions and route loss without taking over WebRTC audio-session activation.'
  s.author = 'T3 Tools'
  s.homepage = 'https://t3tools.com'
  s.platforms = { :ios => '16.1' }
  s.source = { :path => '.' }
  s.static_framework = true
  s.source_files = '**/*.swift'
  s.frameworks = 'AVFoundation'
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
end
