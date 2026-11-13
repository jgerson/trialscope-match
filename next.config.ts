import type { NextConfig } from "next";

const securityHeaders = [
  // Nobody may embed the app in a frame (clickjacking). frame-ancestors is the modern form, X-Frame-Options the fallback.
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  // Browsers must trust declared content types instead of guessing them.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Other sites see only the origin, never full paths such as /patients/<id>.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The app uses none of these browser features.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
