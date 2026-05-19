// Demo landing page for Rove's live-preview pane.
//
// Everything visible on this page is intentionally tweakable in obvious places
// so you can record a demo prompt like "change the headline" or "make the
// primary button green" and see the WebView update in the preview pane.
//
// All design tokens live in src/styles.css under `:root` — easiest single-line
// changes to make on camera.

const FEATURES = [
  { title: 'One key', body: 'Press ⌘K from anywhere — your agent is in your pocket.' },
  { title: 'Zero round-trips', body: 'Patches stream to every device in under 100ms.' },
  { title: 'Audited by default', body: 'Every change is signed, logged, and reversible.' },
];

export default function App() {
  return (
    <div className="page">
      <header className="nav">
        <div className="brand">
          <span className="brand-mark">◇</span>
          <span className="brand-name">Helix</span>
        </div>
        <nav className="links">
          <a href="#product">Product</a>
          <a href="#pricing">Pricing</a>
          <a href="#docs">Docs</a>
        </nav>
        <a className="btn ghost compact" href="#signin">Sign in</a>
      </header>

      <main className="hero">
        <span className="badge">v0.1 · in beta</span>
        <h1 className="headline">
          Edit prod from your <em>pocket.</em>
        </h1>
        <p className="lede">
          The fastest way to ship a hotfix is to have your editor in your hand.
          Helix puts the deploy where the alert is.
        </p>
        <div className="ctas">
          <button className="btn primary">Get early access</button>
          <button className="btn ghost">Watch demo →</button>
        </div>
      </main>

      <section className="grid">
        {FEATURES.map((f) => (
          <article key={f.title} className="card">
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </article>
        ))}
      </section>

      <footer className="foot">
        Built for the kind of engineer who fixes the bug while waiting for coffee.
      </footer>
    </div>
  );
}
