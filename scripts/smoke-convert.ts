// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/** Offline smoke test for sheet music -> ABC conversion (ABC passthrough + n8n OMR mock). */
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { convertSheetMusic } from "../src/convert/convert.js";

const PORT = 5679;
const PATH = "/webhook/omr-conversion";

const OMR_ABC = `X:1
T:Converted
M:4/4
K:C
C D E F | G A B c |]`;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let data = "";
    try {
      data = JSON.parse(body || "{}").data ?? "";
    } catch {
      /* ignore */
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        abc: data ? OMR_ABC : "",
        valid: Boolean(data),
        errors: data ? [] : ["mock: missing base64 data"],
        warnings: ["mock warning"],
      }),
    );
  });
});

function check(name: string, pass: boolean): void {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (!pass) process.exitCode = 1;
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "music-agent-convert-"));

  // ABC passthrough: validate a dropped .abc without any OMR backend.
  const abcPath = path.join(dir, "dropped.abc");
  await fs.writeFile(abcPath, "X:1\nK:C\nC D E F |]");
  const cfg = loadConfig();
  cfg.conversion.backend = "none";
  cfg.storage = { dir: path.join(dir, "out") };
  const pass = await convertSheetMusic(abcPath, cfg);
  check("abc passthrough is valid", pass.valid && pass.backend === "passthrough");

  // Unsupported type errors clearly.
  const junkPath = path.join(dir, "score.doc");
  await fs.writeFile(junkPath, "not music");
  const junk = await convertSheetMusic(junkPath, cfg);
  check("unsupported type reports error", !junk.valid && junk.errors[0].includes("Unsupported"));

  // n8n OMR backend: payload round-trips to the webhook contract.
  await new Promise<void>((r) => server.listen(PORT, r));
  cfg.conversion.backend = "n8n";
  cfg.conversion.n8n.webhookUrl = `http://localhost:${PORT}${PATH}`;
  const imgPath = path.join(dir, "score.png");
  await fs.writeFile(imgPath, Buffer.from([1, 2, 3, 4]));
  const omr = await convertSheetMusic(imgPath, cfg);
  check("n8n OMR returns ABC", omr.valid && omr.backend === "n8n" && omr.abc === OMR_ABC);
  check("n8n OMR propagates warnings", omr.warnings.includes("mock warning"));
  server.close();

  await fs.rm(dir, { recursive: true, force: true });
  if (process.exitCode) process.exit(1);
  console.log("\nAll conversion smoke checks passed.");
}

main().catch((e) => {
  console.error(e);
  server.close();
  process.exit(1);
});