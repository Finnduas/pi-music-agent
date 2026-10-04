// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/**
 * Offline smoke test for the n8n validation backend.
 * Starts a mock webhook server and verifies the HTTP client contract.
 * Run: npx tsx scripts/smoke-n8n.ts
 */
import http from "node:http";
import { createValidator } from "../src/validate/validator.js";

const PORT = 5678;
const PATH = "/webhook/notation-validation";

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let notation = "";
    try {
      notation = JSON.parse(body || "{}").notation ?? "";
    } catch {
      /* ignore */
    }
    const valid = /^\s*X\s*:/m.test(notation) && /^\s*K\s*:/m.test(notation);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        valid,
        errors: valid ? [] : ["mock: missing header"],
        warnings: ["mock warning"],
      }),
    );
  });
});

async function main() {
  await new Promise<void>((r) => server.listen(PORT, r));
  const validator = createValidator({
    backend: "n8n",
    n8n: { webhookUrl: `http://localhost:${PORT}${PATH}`, timeoutMs: 5000 },
  });

  const bad = await validator.validate({ notation: "K:D\n|abc|" });
  const good = await validator.validate({ notation: "X:1\nK:D\nD E F G |]" });

  console.log("BAD :", JSON.stringify(bad));
  console.log("GOOD:", JSON.stringify(good));

  const checks: [string, boolean][] = [
    ["bad is invalid", bad.valid === false],
    ["good is valid", good.valid === true],
    ["backend reported as n8n", bad.backend === "n8n" && good.backend === "n8n"],
    ["errors propagated", bad.errors[0] === "mock: missing header"],
    ["warnings propagated", bad.warnings[0] === "mock warning"],
  ];
  console.log("\n--- checks ---");
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
    if (!pass) ok = false;
  }
  server.close();
  if (!ok) process.exit(1);
  console.log("\nAll n8n backend smoke checks passed.");
}

main().catch((e) => {
  console.error(e);
  server.close();
  process.exit(1);
});
