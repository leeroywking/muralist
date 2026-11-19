import Link from "next/link";
import { CONTACT } from "./siteContact";

// Year is fixed at build time (static export). Production rebuilds on every
// merge to main, so it rolls over with the first deploy of a new year.
const YEAR = new Date().getFullYear();

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <p className="site-footer-copy">© {YEAR} Muraliste. All rights reserved.</p>
      <nav className="site-footer-nav" aria-label="Legal and support">
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/data-deletion">Delete your data</Link>
        <Link href="/contact">Contact</Link>
        <a href={`mailto:${CONTACT.support}`}>{CONTACT.support}</a>
      </nav>
    </footer>
  );
}
