Pod::Spec.new do |s|
  s.name = 'T3VoiceTranscription'
  s.version = '1.0.0'
  s.summary = 'On-device transcription and recording conversion for T3 Code dictation.'
  s.author = 'T3 Tools'
  s.homepage = 'https://t3tools.com'
  s.platform = :ios, '18.0'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'TranscribeCpp'
  s.source_files = '*.swift'
  s.resource_bundles = { 'T3SpeechModels' => ['Resources/catalog.json'] }
  s.frameworks = 'AudioToolbox'
end
