Pod::Spec.new do |s|
  s.name           = 'RoveWebViewSnapshot'
  s.version        = '0.1.0'
  s.summary        = 'Pixel-accurate WKWebView snapshots via the native takeSnapshot API.'
  s.description    = <<-DESC
    Wraps WKWebView.takeSnapshot(with:completionHandler:) so the snapshot is
    sourced from the WebKit content process rather than the host app's
    compositor layer cache. Required for reliable captures on iOS when the
    WebView has been offscreen (view-shot returns stale pixels in that case).
  DESC
  s.author         = 'Rove'
  s.homepage       = 'https://example.com'
  s.license        = 'MIT'
  s.platforms      = { :ios => '15.1', :tvos => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
