// Bundles the CLI into one dependency-free file: dist/cube.mjs.
// The same file is copied into each project as context-cube/.tool/cube.mjs.
import { build } from "esbuild";
import { chmodSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cube.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  loader: { ".md": "text" },
  define: { __CUBE_VERSION__: JSON.stringify(pkg.version) },
  banner: {
    js: [
      "#!/usr/bin/env node",
      `const __CUBE_TOOL_VERSION__ = ${JSON.stringify(pkg.version)};`,
      "import { createRequire as __cubeCreateRequire } from 'node:module';",
      "const require = __cubeCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  legalComments: "none",
  logLevel: "warning",
});
chmodSync("dist/cube.mjs", 0o755);
