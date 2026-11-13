import { CONTACT } from "../siteContact";

export const metadata = {
  title: "Contact – Muraliste",
  description: "How to reach Muraliste for help, privacy requests, legal notices, and security reports."
};

const ROWS: ReadonlyArray<{ heading: string; body: string; email: string }> = [
  {
    heading: "Help, bugs, and feedback",
    body: "Something looks wrong in an estimate, an upload fails, or you have an idea. Screenshots and the image you used help a lot.",
    email: CONTACT.support
  },
  {
    heading: "Privacy and your data",
    body: "Questions about what we store, requests to export or delete your data, or anything covered by the privacy policy.",
    email: CONTACT.privacy
  },
  {
    heading: "Legal and copyright",
    body: "Notices about the terms of service, trademark questions, or a claim that content stored here infringes your rights.",
    email: CONTACT.legal
  },
  {
    heading: "Security",
    body: "Report a vulnerability. Please give us a reasonable chance to fix it before sharing details publicly.",
    email: CONTACT.security
  }
];

export default function ContactPage() {
  return (
    <main className="page-shell">
      <section className="panel about-panel">
        <div className="section-head">
          <h1>Contact</h1>
          <p>Email is the best way to reach us. Pick the address that fits and we will get back to you.</p>
        </div>
        <div className="about-grid">
          {ROWS.map((row) => (
            <article className="about-card" key={row.email}>
              <h2>{row.heading}</h2>
              <p>{row.body}</p>
              <p>
                <a href={`mailto:${row.email}`}>{row.email}</a>
              </p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
