// next.config.mjs
/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable experimental features for Edge optimization
  experimental: {
    // Optimize package imports to reduce cold start bundle size
    optimizePackageImports: [
      // "pusher" removed — server SDK uses Node.js crypto, breaks Edge Runtime bundle
      "pusher-js",
      "@upstash/redis",
      "@upstash/ratelimit",
      "zod",
    ],
    // Enable PPR for faster page loads (if using App Router pages)
    ppr: false,
  },

  // Turbopack for faster dev builds
  turbopack: {},

  // Logging for Vercel
  logging: {
    fetches: {
      fullUrl: process.env.NODE_ENV === "development",
    },
  },

  // Headers for all API routes
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },

  // Webpack config for ws package (needed by Neon)
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Don't bundle server-only packages on client
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        dns: false,
        ws: false,
        crypto: false, // pusher server SDK uses crypto — must exclude from client/edge bundles
      };
    }
    return config;
  },
};

export default nextConfig;
