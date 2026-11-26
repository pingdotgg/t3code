Pod::Spec.new do |s|
  s.name = 'T3VoiceTranscription'
  s.version = '1.0.0'
  s.summary = 'Local recording conversion for Hyakki dictation.'
  s.author = 'T3 Tools'
  s.homepage = 'https://github.com/neur0map/hyakki'
  s.platform = :ios, '18.0'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'AudioToolbox'
end
