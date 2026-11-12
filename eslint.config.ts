// Lint rules: typescript-eslint's strict type-checked rules plus a few house rules, applied with the repository's three
// TypeScript projects (the Workers code, the tests and scripts under Node, and the status page script). `npm run lint`.
// The Worker takes a Clock and a RandomSource wherever logic is tested, and reads the wall clock only at its runtime edges.
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  // status-page/src/components/ui and lib/motion-tokens.ts are TUFFUI source copied in by the shadcn CLI: kept as published.
  { ignores: ["node_modules/**", "dist/**", ".wrangler/**", "status-page/dist/**", "status-page/src/components/ui/**", "status-page/src/lib/motion-tokens.ts"] },
  {
    files: ["**/*.ts", "status-page/src/**/*.tsx"],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.test.json", "./status-page/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "@typescript-eslint/no-explicit-any": ["error", { fixToUnknown: false, ignoreRestArgs: false }],
      "@typescript-eslint/ban-ts-comment": ["error", { "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true, "ts-check": false }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/strict-boolean-expressions": ["error", { allowString: false, allowNumber: false, allowNullableObject: true }],
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      eqeqeq: ["error", "always"],
      "no-param-reassign": "error",
      "prefer-const": "error",
    },
  },
);
