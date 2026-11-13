import Link from "next/link";
import { CONTACT, LEGAL_LAST_UPDATED } from "../siteContact";

export const metadata = {
  title: "Terms of Service – Muraliste",
  description: "The rules for using Muraliste, who owns your artwork, and the limits of paint estimates."
};

export default function TermsPage() {
  return (
    <main className="page-shell">
      <article className="panel legal-doc">
        <h1>Terms of Service</h1>
        <p className="legal-updated">Last updated {LEGAL_LAST_UPDATED}</p>

        <p>
          These terms apply when you use Muraliste at muraliste.com. By using the site, you agree to them. If you
          don&rsquo;t agree, please don&rsquo;t use Muraliste.
        </p>

        <h2>Your artwork stays yours</h2>
        <p>
          You keep all rights to the artwork you upload and the palettes and plans you create. When you save a project,
          you give us a limited, non-exclusive permission to store, process, and display it <strong>back to you</strong>,
          only as needed to run Muraliste. This permission ends when the project is permanently deleted. We do not
          publish your artwork, show it to other users, or use it to train AI models.
        </p>

        <h2>What you can upload</h2>
        <p>
          Only upload artwork you own or have permission to use. Don&rsquo;t use Muraliste to store unlawful content or
          to attack, overload, or reverse-engineer the service. We may suspend accounts that do.
        </p>

        <h2>Estimates are estimates</h2>
        <p>
          Paint quantities, color matches, mixing suggestions, and prices are planning aids, not guarantees. Coverage
          depends on your wall, primer, application, and product. Prices are approximate retail snapshots and may differ
          in store. Check quantities and colors with your supplier before buying, and test mixes before painting.
        </p>

        <h2>Brands</h2>
        <p>
          Paint brand and retailer names are trademarks of their owners and are used only to identify products.
          Muraliste is not affiliated with, endorsed by, or sponsored by any paint brand or retailer. If we ever earn a
          commission from a link, we will say so next to it.
        </p>

        <h2>Accounts and plans</h2>
        <p>
          You sign in with a third-party provider and are responsible for activity on your account. The free plan has a
          project limit. Going over it makes projects read-only but never deletes them. You can delete your account at
          any time; see <Link href="/privacy">Privacy</Link> and <Link href="/data-deletion">Delete your data</Link>.
        </p>

        <h2>Copyright complaints</h2>
        <p>
          If you believe something stored on Muraliste infringes your copyright, email{" "}
          <a href={`mailto:${CONTACT.legal}`}>{CONTACT.legal}</a> with the work, where it appears, and your contact
          details. We will look into it promptly.
        </p>

        <h2>No warranty and limits of liability</h2>
        <p>
          Muraliste is provided &ldquo;as is&rdquo;, without warranties of any kind. To the extent the law allows, we
          are not liable for indirect or consequential losses, including paint purchased based on an estimate. Nothing
          in these terms limits rights you have under consumer law that cannot be waived.
        </p>

        <h2>Changes</h2>
        <p>
          We may update these terms. We will change the date above when we do, and will give notice in the app for
          material changes. Questions go to <a href={`mailto:${CONTACT.legal}`}>{CONTACT.legal}</a>.
        </p>
      </article>
    </main>
  );
}
