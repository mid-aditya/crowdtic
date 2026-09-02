/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { serverActions: { allowedOrigins: ["*"] } },
  async headers() {
    return [{ source: "/(.*)", headers: [{ key: "x-tiket-edge", value: "1" }] }];
  },
};
export default nextConfig;
