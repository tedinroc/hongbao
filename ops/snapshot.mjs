#!/usr/bin/env node
// Refresh web/public/snapshot.json from the live /api/stats endpoint before a deploy, so the
// landing page shows real numbers on first paint. Chains that fail keep their previous entry.
//   node ops/snapshot.mjs [baseUrl]   (default https://hongbao.trytry.net)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "web/public/snapshot.json");
const BASE = process.argv[2] || "https://hongbao.trytry.net";
const snap = JSON.parse(readFileSync(FILE, "utf8"));
const deployments = JSON.parse(readFileSync(join(ROOT, "config/deployments.json"), "utf8"));

for (const [id, d] of Object.entries(deployments)) {
  if (!d.hongbao || !d.enabled) continue;
  try {
    const res = await fetch(`${BASE}/api/stats?chainId=${id}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    snap.chains[id] = { stats: body.stats, recent: body.recent ?? [] };
    console.log(`chain ${id}: ${JSON.stringify(body.stats)}`);
  } catch (e) {
    console.warn(`chain ${id}: kept previous snapshot (${e.message})`);
  }
}
snap.generatedAt = new Date().toISOString();
writeFileSync(FILE, JSON.stringify(snap, null, 2) + "\n");
console.log("wrote", FILE);
