// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/** Shared types for the composition harness. */

export interface CriticReport {
  score: number; // 0-10
  strengths: string[];
  issues: string[];
  suggestions: string[];
  summary: string;
  raw?: string;
}

export interface CompositionMeta {
  id: string;
  title: string;
  style?: string;
  request: string;
  abc: string;
  critic: CriticReport | null;
  iterations: number;
  validationWarnings: string[];
  files: string[];
  engine: string;
  composerModel: string;
  criticModel: string;
  createdAt: string;
}

export interface ComposeRequest {
  request: string;
  style?: string;
  title?: string;
  /** If provided, skip composition and start from this ABC. */
  existingAbc?: string;
}

export interface ComposeResult extends CompositionMeta {
  durationMs: number;
  log: string[];
}
