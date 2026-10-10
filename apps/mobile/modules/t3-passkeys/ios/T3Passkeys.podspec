Pod::Spec.new do |s|
  s.name           = 'T3Passkeys'
  s.version        = '1.0.0'
  s.summary        = 'Passkeys for T3 Code server browser pages.'
  s.description    = 'Answers a server browser page\'s WebAuthn requests with the system passkey sheet.'
  s.author         = 'T3 Tools'
  s.homepage       = 'https://t3tools.com'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AuthenticationServices'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
