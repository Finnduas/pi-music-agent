/** Extract ABC notation or JSON from an LLM response. */

/** Pull the most likely ABC music block out of an LLM reply. */
export function extractAbc(text: string): string {
  const fence = /```(?:abc|abcjs|text)?\s*\n([\s\S]*?)```/gi;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    if (looksLikeAbc(m[1])) blocks.push(m[1].trim());
  }
  if (blocks.length) {
    // Prefer the longest block that contains a tune body.
    return blocks.sort((a, b) => b.length - a.length)[0];
  }

  // No fences: take from the first X: header onward.
  const idx = text.search(/^\s*X\s*:/m);
  if (idx >= 0) return text.slice(idx).trim();

  return text.trim();
}

export function looksLikeAbc(s: string): boolean {
  return /^\s*X\s*:/m.test(s) && /^\s*K\s*:/m.test(s);
}

/** Pull a JSON object out of an LLM reply, tolerating code fences. */
export function extractJson<T = unknown>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) throw new Error("No JSON found in response");
  const opener = candidate[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === opener) depth++;
    else if (c === closer) {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1)) as T;
    }
  }
  throw new Error("Unbalanced JSON in response");
}
