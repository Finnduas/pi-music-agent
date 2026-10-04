// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/** Persist compositions as one JSON record per piece in the output folder. */

import fs from "node:fs/promises";
import path from "node:path";
import type { CompositionMeta } from "../types.js";

export interface StoreOptions {
  dir: string;
}

export class Store {
  constructor(private opts: StoreOptions) {}

  async init(): Promise<void> {
    await fs.mkdir(this.opts.dir, { recursive: true });
  }

  /** Write the record (<id>.json); returns its path. */
  async save(meta: CompositionMeta): Promise<string> {
    await this.init();
    const recordPath = path.join(this.opts.dir, `${meta.id}.json`);
    await fs.writeFile(recordPath, JSON.stringify(meta, null, 2));
    return recordPath;
  }

  /** All stored records, newest first. */
  async list(): Promise<CompositionMeta[]> {
    let names: string[] = [];
    try {
      names = (await fs.readdir(this.opts.dir)).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out: CompositionMeta[] = [];
    for (const n of names) {
      try {
        const rec = JSON.parse(await fs.readFile(path.join(this.opts.dir, n), "utf8"));
        if (rec && rec.id && rec.abc !== undefined) out.push(rec);
      } catch {
        /* not a record */
      }
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
}
