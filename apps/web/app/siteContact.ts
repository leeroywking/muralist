// Public, receive-only role addresses. They are forwarded via Cloudflare Email
// Routing; the product itself never sends email (see docs/RETENTION_POLICY.md).
export const CONTACT = {
  support: "support@muraliste.com",
  privacy: "privacy@muraliste.com",
  legal: "legal@muraliste.com",
  security: "security@muraliste.com"
} as const;

export const LEGAL_LAST_UPDATED = "November 13, 2026";
