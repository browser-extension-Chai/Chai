import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "warn",
      "eqeqeq": "error",
      "no-var": "error",
      "prefer-const": "warn",
    },
  },
  {
    // Unit tests run under Node, not in a browser or extension context.
    files: ["test/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
