import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message: "Direct access to process.env is not allowed. Use serverEnv from src/serverEnv.ts instead.",
        },
      ],
    },
  },
  {
    files: ["src/serverEnv.ts"],
    rules: {
      "no-restricted-properties": "off",
    },
  },
];
