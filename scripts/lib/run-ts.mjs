#!/usr/bin/env node
// Bundle a TypeScript/ESM entry with esbuild (same bundler Pages Functions use)
// and run it with Node. Dependencies resolve from web/node_modules, so scripts
// can import viem and the Pages Functions handlers directly.
//
//   node scripts/lib/run-ts.mjs scripts/e2e/fork-e2e.ts
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const webModules = join(root, "web", "node_modules");
const require = createRequire(join(root, "web", "package.json"));
const esbuild = require("esbuild");

const entry = process.argv[2];
if (!entry) {
  console.error("usage: run-ts.mjs <entry.ts>");
  process.exit(2);
}

const outDir = mkdtempSync(join(tmpdir(), "hongbao-run-"));
const outFile = join(outDir, "bundle.mjs");
try {
  await esbuild.build({
    entryPoints: [resolve(entry)],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    nodePaths: [webModules],
    sourcemap: "inline",
    logLevel: "warning",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  await import(pathToFileURL(outFile).href);
} finally {
  if (!process.env.KEEP_BUNDLE) rmSync(outDir, { recursive: true, force: true });
}
