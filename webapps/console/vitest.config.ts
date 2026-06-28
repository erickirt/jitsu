import { defineConfig } from "vitest/config";

export default defineConfig({
  // Use the automatic JSX runtime so tests that transitively import `.tsx` files
  // (e.g. the destinations catalog → icon components) don't fail with
  // "React is not defined". The app compiles JSX via Next's automatic runtime;
  // this keeps vitest consistent (tsconfig keeps `jsx: preserve` for Next).
  esbuild: { jsx: "automatic" },
  test: {
    globals: true,
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    env: {
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      JWT_SECRET: "test-jwt-secret",
      NEXTAUTH_SECRET: "test-nextauth-secret",
    },
  },
});
