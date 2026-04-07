const providers = ["Google", "Apple", "Facebook", "Guest mode"];

export default function HomePage() {
  return (
    <main className="page-shell">
      <section className="hero">
        <p className="eyebrow">Prototype Foundation</p>
        <h1>Muralist</h1>
        <p className="lede">
          Upload artwork, collapse digital shading into a practical palette, and
          estimate paint with configurable brand coverage assumptions.
        </p>
        <div className="provider-grid">
          {providers.map((provider) => (
            <span key={provider} className="pill">
              {provider}
            </span>
          ))}
        </div>
      </section>

      <section className="card-grid">
        <article className="card">
          <h2>OAuth-first access</h2>
          <p>
            Saved projects and personal paint libraries require sign-in through
            common identity providers. Guest mode is available, but it cannot
            persist data.
          </p>
        </article>
        <article className="card">
          <h2>AWS-ready backend</h2>
          <p>
            The service boundary is shaped for DynamoDB, object storage, and
            federated identity without coupling the foundation to AWS-specific
            SDKs too early.
          </p>
        </article>
        <article className="card">
          <h2>Configurable brand coefficients</h2>
          <p>
            Initial rough defaults are seeded for Sherwin-Williams, Valspar, and
            Behr in a backend-owned catalog that can later become user scoped.
          </p>
        </article>
      </section>
    </main>
  );
}

