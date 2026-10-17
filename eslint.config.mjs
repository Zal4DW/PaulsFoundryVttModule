import js from "@eslint/js";
import globals from "globals";

// Globals that Foundry VTT defines in the browser at runtime.
const foundryGlobals = {
  game: "readonly",
  Hooks: "readonly",
  ui: "readonly",
  foundry: "readonly",
  CONFIG: "readonly",
  CONST: "readonly",
  canvas: "readonly",
  ChatMessage: "readonly",
  fromUuidSync: "readonly",
  Actor: "readonly",
  quench: "readonly"
};

export default [
  { ignores: ["node_modules/", ".foundry/", "test-results/", "playwright-report/"] },
  js.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.browser, ...foundryGlobals } }
  },
  {
    files: ["test/**/*.mjs", "tools/**/*.mjs", "*.config.mjs"],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    // Code inside page.evaluate() runs in the Foundry page, not in Node.
    files: ["test/e2e/**/*.mjs"],
    languageOptions: { globals: { ...globals.browser, ...foundryGlobals } }
  },
  {
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  }
];
