/** Persist compositions to a folder (+ optional SQLite index, JSONL fallback). */

import fs from "node:fs/promises";
import path from "node:path";
import type { CompositionMeta } from "../types.js";

export interface StoreOptions {
  dir: string;
  database?: string;
}

export class Store {
  private sqlite: any | null = null;

  constructor(private opts: StoreOptions) {}

  /** Create the storage dir and, if configured, the SQLite index. */
  async init(): Promise<void> {
    await fs.mkdir(this.opts.dir, { recursive: true });
    if (this.opts.database) {
      try {
        const mod: any = await import("better-sqlite3");
        const Database = mod.default ?? mod;
        const dbPath = path.resolve(process.cwd(), this.opts.database);
        await fs.mkdir(path.dirname(dbPath), { recursive: true });
        this.sqlite = new Database(dbPath);
        this.sqlite.exec(`
          CREATE TABLE IF NOT EXISTS compositions (
            id TEXT PRIMARY KEY,
            title TEXT,
            style TEXT,
            score REAL,
            abc TEXT,
            meta TEXT,
            created_at TEXT
          )
        `);
      } catch (e: any) {
        this.sqlite = null;
        console.error(
          `[store] SQLite unavailable (${e?.message ?? e}); using folder + index.jsonl`,
        );
      }
    }
  }

  /** Write the ABC, a JSON sidecar and an index entry; return the record path. */
  async save(meta: CompositionMeta): Promise<string> {
    await fs.mkdir(this.opts.dir, { recursive: true });
    const recordPath = path.join(this.opts.dir, `${meta.id}.json`);
    await fs.writeFile(recordPath, JSON.stringify(meta, null, 2));

    const indexLine = JSON.stringify({
      id: meta.id,
      title: meta.title,
      style: meta.style ?? null,
      score: meta.critic?.score ?? null,
      createdAt: meta.createdAt,
      files: meta.files,
    });
    await fs.appendFile(path.join(this.opts.dir, "index.jsonl"), indexLine + "\n");

    if (this.sqlite) {
      try {
        this.sqlite
          .prepare(
            `INSERT OR REPLACE INTO compositions
             (id, title, style, score, abc, meta, created_at)
             VALUES (@id, @title, @style, @score, @abc, @meta, @created_at)`,
          )
          .run({
            id: meta.id,
            title: meta.title,
            style: meta.style ?? null,
            score: meta.critic?.score ?? null,
            abc: meta.abc,
            meta: JSON.stringify(meta),
            created_at: meta.createdAt,
          });
      } catch (e: any) {
        console.error(`[store] SQLite insert failed: ${e?.message ?? e}`);
      }
    }
    return recordPath;
  }

  async get(id: string): Promise<CompositionMeta | null> {
    if (this.sqlite) {
      try {
        const row = this.sqlite
          .prepare("SELECT meta FROM compositions WHERE id = ?")
          .get(id);
        if (row?.meta) return JSON.parse(row.meta) as CompositionMeta;
      } catch {
        /* fall through to filesystem */
      }
    }
    try {
      const p = path.join(this.opts.dir, `${id}.json`);
      return JSON.parse(await fs.readFile(p, "utf8")) as CompositionMeta;
    } catch {
      return null;
    }
  }

  async list(): Promise<Partial<CompositionMeta>[]> {
    if (this.sqlite) {
      try {
        return this.sqlite
          .prepare(
            "SELECT id, title, style, score, created_at FROM compositions ORDER BY created_at DESC",
          )
          .all()
          .map((r: any) => ({
            id: r.id,
            title: r.title,
            style: r.style,
            critic: r.score != null ? ({ score: r.score } as any) : null,
            createdAt: r.created_at,
          }));
      } catch {
        /* fall through */
      }
    }
    try {
      const lines = (await fs.readFile(path.join(this.opts.dir, "index.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean);
      return lines.map((l) => JSON.parse(l)).reverse();
    } catch {
      return [];
    }
  }
}
