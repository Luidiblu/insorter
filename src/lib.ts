// Pure logic shared by the server and the UI (served to the browser as /lib.js). No I/O here.

export type Relation = "mutual" | "you_follow" | "follows_you" | "pending" | "none";

export type AccountLike = { you_follow: boolean; follows_you: boolean; pending_request: boolean };

export function relationOf(a: AccountLike): Relation {
  if (a.you_follow && a.follows_you) return "mutual";
  if (a.you_follow) return "you_follow";
  if (a.follows_you) return "follows_you";
  if (a.pending_request) return "pending";
  return "none";
}

// Lowercase, no diacritics, non-alphanumerics collapsed to single spaces, padded so word matches can anchor on spaces.
export function normalize(s: string | null | undefined): string {
  return " " + String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
}

export type Suggestion = { group: string; hits: string[] };

// Matches the user's keywords per group against the account's text fields. Short words (< 4 chars) must match whole words;
// longer ones may match inside words (so "smith" hits "@jsmith_"). Best group = most distinct hits; ties keep group order.
export function suggest(keywords: Record<string, string[]>, groups: string[], fields: (string | null | undefined)[]): Suggestion | null {
  const hay = normalize(fields.filter(Boolean).join(" "));
  let best: Suggestion | null = null;
  for (const group of groups) {
    const words = keywords[group];
    if (!words?.length) continue;
    const hits = words.filter(w => {
      const n = normalize(w).trim();
      return n && (n.length >= 4 ? hay.includes(n) : hay.includes(" " + n + " "));
    });
    if (hits.length && (!best || hits.length > best.hits.length)) best = { group, hits };
  }
  return best;
}

export type GroupsConfig = { buckets: string[]; special: string[]; keywords: Record<string, string[]> };

export function validateGroups(buckets: unknown, special: unknown, keywords: unknown): GroupsConfig | string {
  const clean = (v: unknown) => Array.isArray(v) ? v.map(x => String(x ?? "").trim().replace(/\s+/g, " ")) : null;
  const b = clean(buckets), s = clean(special);
  if (!b || !s) return "invalid format";
  const all = [...b, ...s];
  if (all.some(x => !x || x.length > 40)) return "a group name is empty or longer than 40 characters";
  if (new Set(all.map(x => x.toLowerCase())).size !== all.length) return "duplicate group names";
  if (b.length > 9) return "at most 9 groups (keys 1–9)";
  const kw: Record<string, string[]> = {};
  if (keywords && typeof keywords === "object") {
    for (const [g, words] of Object.entries(keywords as Record<string, unknown>)) {
      if (!all.includes(g) || !Array.isArray(words)) continue;
      const list = [...new Set(words.map(w => String(w ?? "").trim().toLowerCase()).filter(w => w && w.length <= 40))].slice(0, 100);
      if (list.length) kw[g] = list;
    }
  }
  return { buckets: b, special: s, keywords: kw };
}

export function csvRow(cells: unknown[]): string {
  return cells.map(v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(",");
}

export type Snapshot = { pk: string; username: string; full_name: string; pic?: string; you_follow: boolean; follows_you: boolean; pending_request: boolean };
export type Changes = {
  unfollowed_you: Snapshot[]; new_followers: Snapshot[]; you_unfollowed: Snapshot[]; you_followed: Snapshot[]; new_requests: Snapshot[];
};

// What changed between two collections, by account id. An account missing from `next` entirely counts as lost in every direction it had.
export function diffAccounts(prev: Snapshot[], next: Snapshot[]): Changes {
  const before = new Map(prev.map(a => [a.pk, a]));
  const after = new Map(next.map(a => [a.pk, a]));
  const out: Changes = { unfollowed_you: [], new_followers: [], you_unfollowed: [], you_followed: [], new_requests: [] };
  for (const [pk, a] of before) {
    const b = after.get(pk);
    if (a.follows_you && !b?.follows_you) out.unfollowed_you.push(b ?? a);
    if (a.you_follow && !b?.you_follow) out.you_unfollowed.push(b ?? a);
  }
  for (const [pk, b] of after) {
    const a = before.get(pk);
    if (b.follows_you && !a?.follows_you) out.new_followers.push(b);
    if (b.you_follow && !a?.you_follow) out.you_followed.push(b);
    if (b.pending_request && !a?.pending_request) out.new_requests.push(b);
  }
  const byName = (x: Snapshot, y: Snapshot) => x.username.localeCompare(y.username);
  for (const list of Object.values(out)) list.sort(byName);
  return out;
}
