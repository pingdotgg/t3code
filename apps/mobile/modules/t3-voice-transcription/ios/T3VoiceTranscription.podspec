Pod::Spec.new do |s|
  s.name           = 'T3VoiceTranscription'
  s.version        = '1.0.0'
  s.summary        = 'On-device dictation for T3 Code mobile.'
  s.description    = 'Streams SpeechAnalyzer dictation into the composer and converts local recordings.'
  s.author         = 'T3 Tools'
  s.homepage       = 'https://t3tools.com'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '*.swift'
  s.frameworks = 'AudioToolbox'
end
