/** @type {import('next').NextConfig} */
const isGitHubPages = process.env.GITHUB_PAGES === "true";
const repoBasePath = process.env.GITHUB_PAGES_BASE_PATH ?? "/muralist";

const nextConfig = {
  reactStrictMode: true,
  output: "export",
  images: {
    unoptimized: true
  },
  trailingSlash: true,
  basePath: isGitHubPages ? repoBasePath : "",
  assetPrefix: isGitHubPages ? repoBasePath : undefined
};

export default nextConfig;
