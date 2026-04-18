#!/usr/bin/env node
// Bundle src/server.ts → dist/server.js with all dependencies inlined.
// Produces a single runnable file so end users don't need `pnpm install` after
// Claude Code pulls the plugin from the marketplace.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { chmodSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, "..");

const result = await build({
  entryPoints: [resolve(SERVER_ROOT, "src/server.ts")],
  outfile: resolve(SERVER_ROOT, "dist/server.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  // Inline all npm deps so the bundle is self-contained. Node built-ins resolve
  // naturally via the `node:` prefix; esbuild treats them as external by default.
  packages: "bundle",
  // xsschema (transitive dep of fastmcp) optionally imports `effect`, `sury`, and
  // `@valibot/to-json-schema` for alternate schema engines. We use zod exclusively,
  // so those optional imports never fire at runtime. Mark them external to satisfy
  // the bundler — xsschema's `tryImport` wrapper handles the missing module gracefully.
  external: ["effect", "sury", "@valibot/to-json-schema"],
  // Banner fixes two ESM-bundle issues:
  //   1. `require()` not available in ESM — some deps (adf-to-md via CJS interop)
  //      use require internally; we synthesize it.
  //   2. `__dirname`/`__filename` not defined in ESM — same fix pattern.
  // Source file's own `#!/usr/bin/env node` shebang is preserved by esbuild.
  // Banner runs AFTER the shebang and adds ESM shims for require / __filename /
  // __dirname (some transitive deps expect them).
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __dirname_fn } from 'node:path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __dirname_fn(__filename);",
    ].join("\n"),
  },
  // Keep the bundle legible — users may want to grep it for debugging. Dead-code
  // elimination still happens at the import level.
  minify: false,
  legalComments: "none",
  logLevel: "info",
});

// chmod +x so `node dist/server.js` isn't the only way to launch it.
chmodSync(resolve(SERVER_ROOT, "dist/server.js"), 0o755);

if (result.warnings.length > 0) {
  console.error(`[bundle] ${result.warnings.length} warning(s); see above.`);
}
console.error("[bundle] ok");
