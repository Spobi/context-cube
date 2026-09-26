import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

// Prompts are imported as text (esbuild's text loader does the same in the bundle).
export default defineConfig({
  plugins: [
    {
      name: "md-as-text",
      transform(_code, id) {
        if (id.endsWith(".md")) {
          return { code: `export default ${JSON.stringify(readFileSync(id, "utf8"))};`, map: null };
        }
      },
    },
  ],
  define: { __CUBE_VERSION__: JSON.stringify("0.0.0-test") },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/globalSetup.ts"],
    testTimeout: 30000,
  },
});
