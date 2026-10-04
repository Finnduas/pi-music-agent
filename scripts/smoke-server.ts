// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/**
 * Offline smoke test for the HTTP API used by the n8n workflows.
 * Covers routes that need no LLM, plus path safety and error handling.
 * Run: npx tsx scripts/smoke-server.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.js";
import { createServer, resolveInside } from "../src/server.js";

const ABC = "X:1\nT:T\nM:4/4\nL:1/4\nK:C\nC D E F | G A B c |]\n";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "music-agent-server-"));
await fs.mkdir(path.join(root, ".input"), { recursive: true });
await fs.writeFile(path.join(root, ".input", "scale.abc"), ABC);
await fs.writeFile(path.join(root, ".input", "gap.abc"), ABC.replace("G A B c", '"^GAP" z4'));
await fs.writeFile(path.join(root, ".input", "scan.pdf"), "%PDF-1.4 fake");

const cfg = loadConfig();
cfg.storage.dir = path.join(root, ".output");
cfg.conversion.backend = "none";

const server = createServer(cfg, root);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function call(method: string, route: string, body?: unknown, raw?: string) {
  const res = await fetch(base + route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  return { status: res.status, json: (await res.json()) as any };
}

let failed = false;
const check = (name: string, pass: boolean) => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (!pass) failed = true;
};

const health = await call("GET", "/health");
check("health lists routes", health.status === 200 && health.json.ok && health.json.routes.includes("POST /compose"));

const an = await call("POST", "/analyze", { file: ".input/scale.abc" });
check("analyze by file", an.status === 200 && an.json.key?.includes("C") && an.json.gaps.length === 0);

const anAbs = await call("POST", "/analyze", { file: path.join(root, ".input", "gap.abc") });
check("analyze by absolute path inside root reports the gap", anAbs.status === 200 && anAbs.json.gaps.length === 1);

const anInline = await call("POST", "/analyze", { abc: ABC });
check("analyze inline abc", anInline.status === 200 && anInline.json.meter === "4/4");

const tr = await call("POST", "/transpose", { file: ".input/scale.abc", semitones: 7 });
check("transpose up a fifth (C -> G)", tr.status === 200 && /^K:G$/m.test(tr.json.abc));
check("transpose saved a file in the output folder", await fs.readFile(tr.json.file, "utf8").then((t) => t.includes("K:G")).catch(() => false));
check("transpose rejects a non-integer", (await call("POST", "/transpose", { file: ".input/scale.abc", semitones: "x" })).status === 400);

const cv = await call("POST", "/convert", { file: ".input/scale.abc" });
check("convert .abc is a validated passthrough", cv.status === 200 && cv.json.valid === true && cv.json.backend === "passthrough");
check("convert wrote the .abc", typeof cv.json.file === "string" && (await fs.readFile(cv.json.file, "utf8")).includes("K:C"));
const cvPdf = await call("POST", "/convert", { file: ".input/scan.pdf" });
check("convert of a scan without a backend explains itself", cvPdf.status === 200 && cvPdf.json.valid === false && cvPdf.json.errors[0].includes("conversion backend"));

check("path escape is refused (..)", (await call("POST", "/analyze", { file: "../../etc/passwd" })).status === 400);
check("absolute path outside root is refused", (await call("POST", "/analyze", { file: path.resolve(root, "..", "x.abc") })).status === 400);
check("missing file is 404", (await call("POST", "/analyze", { file: ".input/nope.abc" })).status === 404);
check("missing field is 400", (await call("POST", "/compose", {})).status === 400);
check("edit without instruction is 400", (await call("POST", "/edit", { file: ".input/gap.abc" })).status === 400);
check("bad JSON is 400", (await call("POST", "/analyze", undefined, "{nope")).status === 400);
check("unknown route is 404", (await call("GET", "/nope")).status === 404);
check("resolveInside accepts a normal path", resolveInside(root, ".input/a.abc").startsWith(root));

server.close();
await fs.rm(root, { recursive: true, force: true });
if (failed) process.exit(1);
console.log("\nAll server smoke checks passed.");
