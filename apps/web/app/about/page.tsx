export default function AboutPage() {
  return (
    <main className="page-shell">
      <section className="panel about-panel">
        <div className="section-head">
          <h1>About Muralist</h1>
          <p>
            Muralist helps artists turn mural artwork into a practical paint list and rough brand-based paint estimate.
          </p>
        </div>

        <div className="about-grid">
          <article className="about-card">
            <h2>What It Does</h2>
            <p>Upload artwork, reduce close shades into a workable palette, and estimate gallons by brand coverage assumptions.</p>
          </article>
          <article className="about-card">
            <h2>What To Expect</h2>
            <p>The color list is intentionally simplified so digital shading does not become dozens of separate paint purchases.</p>
          </article>
          <article className="about-card">
            <h2>Current Limits</h2>
            <p>This version runs in the browser and does not yet save projects, sync across devices, or handle account features.</p>
          </article>
        </div>
      </section>
    </main>
  );
}
