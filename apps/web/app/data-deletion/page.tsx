import Link from "next/link";
import { CONTACT } from "../siteContact";

export const metadata = {
  title: "Delete Your Data – Muraliste",
  description: "How to export or delete your Muraliste projects and account."
};

// Linked as the "data deletion instructions URL" in sign-in provider consoles
// (Meta requires one). Keep the URL stable.
export default function DataDeletionPage() {
  return (
    <main className="page-shell">
      <article className="panel legal-doc">
        <h1>Delete your data</h1>

        <h2>Guests</h2>
        <p>
          If you never signed in, we have nothing stored about you. Your guest settings live only in your browser;
          clear this site&rsquo;s data in your browser settings to remove them.
        </p>

        <h2>Delete individual projects</h2>
        <p>
          Open <Link href="/projects">Projects</Link> and delete the project. It moves to Trash for 14 days, so you can
          restore it if that was a mistake, and is then permanently erased.
        </p>

        <h2>Export everything or delete your account</h2>
        <p>
          Email <a href={`mailto:${CONTACT.privacy}?subject=Delete%20my%20Muraliste%20account`}>{CONTACT.privacy}</a>{" "}
          from the email address on your account. Say whether you want a copy of your data first. In-app buttons for
          this are on the way.
        </p>
        <p>
          After an account deletion request there is a 30-day window in which you can change your mind. Then all your
          projects, images, sessions, and your account record are permanently erased.
        </p>

        <h2>Signed in with Facebook, Google, Apple, or Adobe?</h2>
        <p>
          Removing Muraliste from your provider&rsquo;s connected-apps settings stops future sign-ins, but it does not
          delete what Muraliste has stored. Use the steps above for that.
        </p>
      </article>
    </main>
  );
}
