import ExpoModulesCore
import WebKit

/// Exposes a single async function `snapshotByTag(viewTag)` that:
///   1. Looks up the React-managed view by its reactTag.
///   2. Walks the subview tree to find the embedded WKWebView
///      (react-native-webview wraps it in an RNCWebViewImpl container).
///   3. Calls `WKWebView.takeSnapshot(with:completionHandler:)` — the
///      Apple-provided WebView snapshot API that goes through the
///      WebKit content process. Unlike UIKit's
///      `drawViewHierarchyInRect:afterScreenUpdates:YES`, this never
///      returns a stale compositor cache.
///   4. Returns the base64-encoded PNG.
///
/// All errors resolve to a typed reject code so the JS layer can
/// pattern-match the cause without parsing message strings.
public class RoveWebViewSnapshotModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RoveWebViewSnapshot")

    AsyncFunction("snapshotByTag") { (viewTag: Int, promise: Promise) in
      // WKWebView APIs must run on the main thread.
      DispatchQueue.main.async { [weak self] in
        guard let self = self, let appContext = self.appContext else {
          promise.reject("ERR_NO_CONTEXT", "Expo app context is not available")
          return
        }
        guard let view = appContext.findView(withTag: viewTag) else {
          promise.reject(
            "ERR_VIEW_NOT_FOUND",
            "No view registered with reactTag \(viewTag) — the WebView may have been unmounted"
          )
          return
        }
        guard let webView = Self.findWKWebView(in: view) else {
          promise.reject(
            "ERR_NOT_WEBVIEW",
            "View tagged \(viewTag) is not a WKWebView (or no WKWebView found in its subtree)"
          )
          return
        }
        let config = WKSnapshotConfiguration()
        // `rect = .null` (the default) means "full visible WebView."
        // We don't need afterScreenUpdates here — takeSnapshot is
        // already content-process-sourced, so it always returns the
        // current rendered state.
        webView.takeSnapshot(with: config) { image, error in
          if let error = error {
            promise.reject("ERR_SNAPSHOT_FAILED", error.localizedDescription)
            return
          }
          guard let image = image else {
            promise.reject("ERR_NO_IMAGE", "takeSnapshot returned no image and no error")
            return
          }
          guard let data = image.pngData() else {
            promise.reject("ERR_NO_DATA", "PNG encoding failed for the captured image")
            return
          }
          promise.resolve(data.base64EncodedString())
        }
      }
    }
  }

  /// Recursively walk a view tree looking for a WKWebView instance.
  /// react-native-webview wraps the real WKWebView in a couple of
  /// container views (RNCWebViewImpl, scroll wrapper, etc.) so the
  /// JS-side ref doesn't point directly at WKWebView — we have to
  /// descend.
  private static func findWKWebView(in view: UIView) -> WKWebView? {
    if let webView = view as? WKWebView { return webView }
    for subview in view.subviews {
      if let found = findWKWebView(in: subview) { return found }
    }
    return nil
  }
}
