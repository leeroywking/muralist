import Link from "next/link";
import { CONTACT, LEGAL_LAST_UPDATED } from "../siteContact";

export const metadata = {
  title: "Privacy Policy – Muraliste",
  description: "What Muraliste stores, why, for how long, who processes it, and how to export or delete it."
};

export default function PrivacyPage() {
  return (
    <main className="page-shell">
      <article className="panel legal-doc">
        <h1>Privacy Policy</h1>
        <p className="legal-updated">Last updated {LEGAL_LAST_UPDATED}</p>

        <p>
          Muraliste (&ldquo;we&rdquo;) helps muralists turn artwork into a paint palette and estimate. This policy explains
          what we collect, why, how long we keep it, and what you can do about it. Questions go to{" "}
          <a href={`mailto:${CONTACT.privacy}`}>{CONTACT.privacy}</a>.
        </p>

        <h2>Using Muraliste without an account</h2>
        <p>
          As a guest, your artwork is analyzed <strong>in your browser</strong>. It is not uploaded to our servers.
          Settings and merge choices you save as a guest are stored in your browser&rsquo;s local storage on that device
          only; clearing your browser data removes them.
        </p>

        <h2>What we store when you sign in</h2>
        <ul>
          <li>
            <strong>Account details from your sign-in provider</strong> (Google, and in future Apple, Facebook, or
            Adobe): your name, email address, and the provider&rsquo;s account identifier. We never receive or store
            your provider password.
          </li>
          <li>
            <strong>Session records</strong> that keep you signed in, which can include your IP address and browser
            type.
          </li>
          <li>
            <strong>Projects you choose to save</strong>: the palette and estimate data, a reduced-size copy of your
            image, and a small thumbnail. Your browser shrinks and re-encodes the image before it leaves your device. We
            never store the original full-resolution file, and photo metadata (EXIF, including location) is removed
            first.
          </li>
        </ul>
        <p>
          We use this data only to run Muraliste for you. We do not sell it, use it for advertising, or use your artwork
          to train AI models. Muraliste has no analytics or advertising trackers.
        </p>

        <h2>Cookies and local storage</h2>
        <ul>
          <li>
            <strong>Session cookie and security (CSRF) cookie</strong>: set only when you sign in; needed to keep you
            signed in safely.
          </li>
          <li>
            <strong>Local storage</strong>: your light/dark theme, Pro settings, and guest merge choices.
          </li>
        </ul>
        <p>All of these are needed for the site to work, so we don&rsquo;t show a consent banner.</p>

        <h2>How long we keep it</h2>
        <ul>
          <li>Saved projects are kept until you delete them or your account. We never delete projects for age or inactivity.</li>
          <li>
            Going over the free plan&rsquo;s project limit makes your projects read-only. It never deletes them.
          </li>
          <li>
            A deleted project goes to Trash and can be restored for <strong>14 days</strong>. After that it is
            permanently erased, including its image and thumbnail.
          </li>
          <li>
            When you delete your account, there is a <strong>30-day</strong> window in which you can cancel. After
            that, all your projects, images, sessions, and your account record are permanently erased.
          </li>
        </ul>

        <h2>Your choices and rights</h2>
        <ul>
          <li>
            <strong>Delete projects</strong> any time from <Link href="/projects">Projects</Link>.
          </li>
          <li>
            <strong>Export or delete everything</strong>: see <Link href="/data-deletion">Delete your data</Link>.
          </li>
          <li>
            <strong>Access or correct</strong> your data, or ask any privacy question, by emailing{" "}
            <a href={`mailto:${CONTACT.privacy}`}>{CONTACT.privacy}</a>. Depending on where you live (for example,
            under GDPR or California law) you may have additional rights. We honor these requests for every user.
          </li>
        </ul>

        <h2>Who processes data for us</h2>
        <ul>
          <li>
            <strong>DigitalOcean</strong>: application and database hosting.
          </li>
          <li>
            <strong>Cloudflare</strong>: DNS, content delivery, security, and email forwarding for our contact
            addresses.
          </li>
          <li>
            <strong>Your sign-in provider</strong> (Google, Apple, Facebook, or Adobe): confirms your identity under
            their own privacy policy.
          </li>
        </ul>

        <h2>Security</h2>
        <p>
          Data is encrypted in transit. Image files are checked on our servers without being opened by image-processing
          libraries. Please report security issues to <a href={`mailto:${CONTACT.security}`}>{CONTACT.security}</a>.
        </p>

        <h2>Children</h2>
        <p>Muraliste is not directed to children under 13, and we do not knowingly collect their data.</p>

        <h2>Changes</h2>
        <p>
          If we change this policy, we will update the date above. If a change materially affects how your saved data
          is used, we will show a notice in the app first.
        </p>
      </article>
    </main>
  );
}
