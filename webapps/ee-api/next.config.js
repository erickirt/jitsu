/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  webpack: (config, opts) => {
    // if (prevWebpack) {
    //   prevWebpack(config, opts);
    // }
    config.module.rules.push({
      test: /\.sql$/,
      use: "raw-loader",
    });
    return config;
  },
  async headers() {
    return [
      {
        source: "/:path*{/}?",
        headers: [
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
        ],
      },
    ];
  },
};

const withTM = require("next-transpile-modules")(["juava"]); // pass the modules you would like to see transpiled

module.exports = withTM(nextConfig);
