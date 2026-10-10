// Insorter server: local, read-only triage UI for Instagram relationships.
// Data lives in ./data; live profile data comes from the logged-in Instagram window inside Tern,
// through the same GraphQL queries the web app runs for a profile page (queries only, never mutations).
import { renameSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evalIn, findInstagramBlock, GQL_PRELUDE, TernError, ternOp } from "./tern";
import { csvRow, relationOf, suggest, validateGroups, type Changes, type GroupsConfig } from "./lib";

const ROOT = join(import.meta.dir, "..");
const DATA = process.env.INSORTER_DATA || join(ROOT, "data");
const PORT = Number(process.env.PORT || 47380);
const MIN_GAP_MS = 1000;

type Account = {
  pk: string; username: string; full_name: string; is_private: boolean; is_verified: boolean; pic?: string;
  you_follow: boolean; follows_you: boolean; pending_request: boolean; last_post: number | null; no_posts: boolean | null;
};
// auto: filed by the keyword rules (reviewable in the lists). Notes live in data/notes.json, independent of decisions.
type Decision = { bucket: string; at: string; username: string; auto?: boolean; hits?: string[] };
type Posts = { last: number | null; n: number; items?: unknown[] };
type Profile = { biography?: string; category?: string; external_url?: string; city?: string; full_name?: string };

function readJson<T>(file: string, fallback: T): T {
  const p = join(DATA, file);
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return fallback; }
}
function writeJsonAtomic(file: string, value: unknown) {
  mkdirSync(DATA, { recursive: true });
  const p = join(DATA, file);
  writeFileSync(p + ".tmp", JSON.stringify(value));
  renameSync(p + ".tmp", p);
}

const accounts = readJson<Account[]>("accounts.json", []);
const byPk = new Map(accounts.map(a => [a.pk, a]));
const decisions = readJson<Record<string, Decision>>("decisions.json", {});
const notes = readJson<Record<string, string>>("notes.json", {});
const profiles = readJson<Record<string, { fetched_at: string; profile?: Profile; posts?: Posts }>>("profiles.json", {});
// Groups are user-defined and live in data/config.json (never in code). keywords[group] feed the suggestions and the auto-sort.
const config = readJson<GroupsConfig>("config.json", { buckets: [], special: ["Trash"], keywords: {} });
if (!config.keywords || typeof config.keywords !== "object") config.keywords = {};
if (!existsSync(join(DATA, "config.json"))) writeJsonAtomic("config.json", config);

let profilesDirty = false;
setInterval(() => { if (profilesDirty) { profilesDirty = false; writeJsonAtomic("profiles.json", profiles); } }, 3000);

// The UI imports the same pure logic the server uses; bundled once at startup.
const libJs = await Bun.build({ entrypoints: [join(import.meta.dir, "lib.ts")], target: "browser", format: "esm", minify: false })
  .then(r => r.success ? r.outputs[0].text() : Promise.reject(new Error("lib build failed: " + r.logs.map(l => l.message).join("; "))));

// ---------- Instagram window (read-only) ----------
let igBlock: number | null = Number(process.env.IG_BLOCK) || null;

async function inInstagram<T>(fn: string, args: unknown[]): Promise<T> {
  if (!igBlock) igBlock = await findInstagramBlock();
  if (!igBlock) throw new Error("No Instagram window open in Tern. Run `bun run collect` or open instagram.com in a Tern browser pane.");
  try { return await evalIn<T>(igBlock, fn, args); }
  catch (e) { if (e instanceof TernError && e.kind === "not_found") igBlock = null; throw e; }
}

let chain: Promise<unknown> = Promise.resolve();
let lastAt = 0;
function serialized<T>(f: () => Promise<T>): Promise<T> {
  const p = chain.then(async () => {
    const wait = lastAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    try { return await f(); } finally { lastAt = Date.now(); }
  });
  chain = p.then(() => undefined, () => undefined);
  return p;
}

const FN_PROFILE = `async (pk) => { ${GQL_PRELUDE}
  const res = await gql('PolarisProfilePageContentQuery', { id: String(pk), enable_integrity_filters: true });
  const u = res.data && res.data.user;
  if (!u) return { error: res.error || (res.status === 200 ? 'no-user' : 'http ' + res.status) };
  const fs = u.friendship_status || {};
  return { profile: {
    pk: String(u.pk || u.id), username: u.username, full_name: u.full_name || '', biography: u.biography || '', category: u.category || '',
    follower_count: u.follower_count, following_count: u.following_count, media_count: u.media_count, mutual_followers_count: u.mutual_followers_count || 0,
    context: (u.profile_context_links_with_user_ids || []).map(c => c.username).filter(Boolean),
    pic: (u.hd_profile_pic_url_info && u.hd_profile_pic_url_info.url) || u.profile_pic_url || '',
    is_private: !!u.is_private, is_verified: !!u.is_verified, is_business: !!u.is_business, is_professional: !!u.is_professional_account,
    account_type: u.account_type, city: u.city_name || '', external_url: u.external_url || (u.bio_links && u.bio_links[0] && u.bio_links[0].url) || '',
    pronouns: u.pronouns || [], latest_reel_media: u.latest_reel_media || 0, is_memorialized: !!u.is_memorialized,
    is_bestie: !!fs.is_bestie, is_feed_favorite: !!fs.is_feed_favorite, is_restricted: !!fs.is_restricted, muting: !!fs.muting,
    following: !!fs.following, followed_by: !!fs.followed_by, incoming_request: !!fs.incoming_request, outgoing_request: !!fs.outgoing_request
  } };
}`;

const FN_POSTS = `async (username) => { ${GQL_PRELUDE}
  const res = await gql('PolarisProfilePostsQuery', { data: { count: 9, include_reel_media_seen_timestamp: true, include_relationship_info: true, latest_besties_reel_media: true, latest_reel_media: true }, username });
  const c = res.data && res.data.xdt_api__v1__feed__user_timeline_graphql_connection;
  if (!c) return { error: res.error || 'no-connection' };
  const items = (c.edges || []).map(e => e.node).filter(n => n && n.taken_at).map(n => {
    const cands = (n.image_versions2 && n.image_versions2.candidates) || [];
    const thumb = cands.filter(x => x.width >= 300).sort((a, b) => a.width - b.width)[0] || cands[0];
    return { code: n.code, taken_at: n.taken_at, media_type: n.media_type, thumb: thumb ? thumb.url : '', caption: ((n.caption && n.caption.text) || '').slice(0, 140),
      likes: n.like_count == null ? null : n.like_count, comments: n.comment_count == null ? null : n.comment_count,
      carousel: n.carousel_media_count || 0, pinned: !!(n.timeline_pinned_user_ids && n.timeline_pinned_user_ids.length) };
  });
  const taken = items.map(i => i.taken_at);
  return { posts: { last: taken.length ? Math.max.apply(null, taken) : null, n: taken.length, items } };
}`;

async function fetchProfile(pk: string, force = false) {
  const cached = profiles[pk];
  if (cached?.profile && !force) return cached;
  const res = await serialized(() => inInstagram<{ error?: string; profile?: Profile }>(FN_PROFILE, [pk]));
  if (res.error) throw new Error(res.error === "non-json" ? "Instagram session invalid (HTML answer). Log in again inside the Instagram window." : res.error);
  profiles[pk] = { ...(profiles[pk] || {}), fetched_at: new Date().toISOString(), profile: res.profile };
  profilesDirty = true;
  return profiles[pk];
}

async function fetchPosts(pk: string, username: string, force = false) {
  const cached = profiles[pk];
  if (cached?.posts?.items && !force) return cached;
  const res = await serialized(() => inInstagram<{ error?: string; posts?: Posts }>(FN_POSTS, [username]));
  if (res.error) throw new Error(res.error);
  profiles[pk] = { ...(profiles[pk] || { fetched_at: new Date().toISOString() }), posts: res.posts };
  profilesDirty = true;
  return profiles[pk];
}

// ---------- domain ----------
const allGroups = () => [...config.buckets, ...config.special];
const textFields = (a: Account) => { const p = profiles[a.pk]?.profile; return [a.username, a.full_name, p?.full_name, p?.biography, p?.category, p?.external_url, p?.city]; };

// Files every undecided account whose keyword suggestion has at least `minHits` distinct hits. Preview when apply=false.
function autosort(minHits: number, apply: boolean) {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const a of accounts) {
    if (decisions[a.pk]) continue;
    const s = suggest(config.keywords, allGroups(), textFields(a));
    if (!s || s.hits.length < minHits) continue;
    counts[s.group] = (counts[s.group] || 0) + 1; total++;
    if (apply) decisions[a.pk] = { bucket: s.group, at: new Date().toISOString(), username: a.username, auto: true, hits: s.hits };
  }
  if (apply && total) writeJsonAtomic("decisions.json", decisions);
  return { total, counts, applied: apply };
}

function exportLists(): string[] {
  const dir = join(DATA, "exports");
  mkdirSync(dir, { recursive: true });
  const header = ["bucket", "username", "full_name", "relation", "you_follow", "follows_you", "pending_request", "is_verified", "is_private", "auto", "note", "decided_at", "url"];
  const decided = (filter: (b: string) => boolean) => accounts.filter(a => decisions[a.pk] && filter(decisions[a.pk].bucket)).sort((x, y) => x.username.localeCompare(y.username));
  const row = (a: Account) => { const d = decisions[a.pk]; return csvRow([d.bucket, a.username, a.full_name, relationOf(a), a.you_follow, a.follows_you, a.pending_request, a.is_verified, a.is_private, !!d.auto, notes[a.pk] || "", d.at, `https://www.instagram.com/${a.username}/`]); };
  const files: string[] = [];
  for (const b of allGroups()) {
    const slug = b.normalize("NFD").replace(/[^\w]+/g, "-").toLowerCase();
    const rows = decided(x => x === b);
    writeFileSync(join(dir, slug + ".csv"), [header.join(","), ...rows.map(row)].join("\n") + "\n");
    writeFileSync(join(dir, slug + ".txt"), rows.map(a => a.username).join("\n") + (rows.length ? "\n" : ""));
    files.push(join(dir, slug + ".csv"), join(dir, slug + ".txt"));
  }
  const all = join(dir, "all.csv");
  writeFileSync(all, [header.join(","), ...decided(() => true).map(row)].join("\n") + "\n");
  files.push(all);
  return files;
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const pksOf = (v: unknown) => Array.isArray(v) ? v.map(String).filter(pk => byPk.has(pk)) : [];

// ---------- HTTP ----------
const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    // Local-only: reject DNS-rebinding (foreign Host) and cross-site POSTs (foreign Origin or non-JSON body).
    const self = `127.0.0.1:${PORT}`;
    if (req.headers.get("host") !== self) return new Response("forbidden", { status: 403 });
    if (req.method === "POST" && (req.headers.get("origin") !== `http://${self}` || !(req.headers.get("content-type") || "").startsWith("application/json"))) {
      return json({ error: "forbidden" }, 403);
    }
    try {
      if (path === "/") return new Response(Bun.file(join(ROOT, "ui", "index.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
      if (path === "/logo.svg") return new Response(Bun.file(join(ROOT, "ui", "logo.svg")), { headers: { "content-type": "image/svg+xml" } });
      if (path === "/lib.js") return new Response(libJs, { headers: { "content-type": "text/javascript; charset=utf-8" } });
      if (path === "/api/state") {
        const changes = readJson<(Changes & { at: string; previous_at: string }) | null>("changes.json", null);
        const summary = changes ? { at: changes.at, previous_at: changes.previous_at, unfollowed_you: changes.unfollowed_you.length, new_followers: changes.new_followers.length, you_unfollowed: changes.you_unfollowed.length, you_followed: changes.you_followed.length, new_requests: changes.new_requests.length } : null;
        return json({ needsCollect: accounts.length === 0, buckets: config.buckets, special: config.special, keywords: config.keywords, accounts, decisions, notes, igBlock, changes: summary, meta: readJson("meta.json", null) });
      }
      if (path === "/api/changes") return json(readJson("changes.json", null));
      if (path === "/api/profile") {
        const pk = url.searchParams.get("pk") || "";
        if (!byPk.has(pk)) return json({ error: "unknown account" }, 404);
        const entry = await fetchProfile(pk, url.searchParams.get("force") === "1");
        return json({ pk, profile: entry.profile, posts: entry.posts || null, fetched_at: entry.fetched_at });
      }
      if (path === "/api/posts") {
        const pk = url.searchParams.get("pk") || "";
        const a = byPk.get(pk);
        if (!a) return json({ error: "unknown account" }, 404);
        const entry = await fetchPosts(pk, a.username, url.searchParams.get("force") === "1");
        return json({ pk, posts: entry.posts });
      }
      if (path === "/api/decide" && req.method === "POST") {
        const body = await req.json() as { pk: string; bucket: string };
        const a = byPk.get(body.pk);
        if (!a) return json({ error: "unknown account" }, 404);
        if (!allGroups().includes(body.bucket)) return json({ error: "unknown group" }, 400);
        decisions[body.pk] = { bucket: body.bucket, at: new Date().toISOString(), username: a.username };
        writeJsonAtomic("decisions.json", decisions);
        return json({ ok: true, decision: decisions[body.pk] });
      }
      if (path === "/api/note" && req.method === "POST") {
        const body = await req.json() as { pk: string; note: string };
        if (!byPk.has(body.pk)) return json({ error: "unknown account" }, 404);
        const note = String(body.note ?? "").trim().slice(0, 500);
        if (note) notes[body.pk] = note; else delete notes[body.pk];
        writeJsonAtomic("notes.json", notes);
        return json({ ok: true, note });
      }
      if (path === "/api/bulk" && req.method === "POST") {
        const body = await req.json() as { pks: unknown; bucket: string };
        if (!allGroups().includes(body.bucket)) return json({ error: "unknown group" }, 400);
        const pks = pksOf(body.pks);
        for (const pk of pks) decisions[pk] = { ...(decisions[pk] || {}), bucket: body.bucket, at: new Date().toISOString(), username: byPk.get(pk)!.username, auto: false };
        if (pks.length) writeJsonAtomic("decisions.json", decisions);
        return json({ ok: true, moved: pks.length });
      }
      if (path === "/api/undecide" && req.method === "POST") {
        const body = await req.json() as { pk?: string; pks?: unknown };
        const pks = body.pk ? [String(body.pk)] : pksOf(body.pks);
        for (const pk of pks) delete decisions[pk];
        writeJsonAtomic("decisions.json", decisions);
        return json({ ok: true, removed: pks.length });
      }
      if (path === "/api/autosort" && req.method === "POST") {
        const body = await req.json() as { minHits?: number; apply?: boolean };
        const minHits = Math.max(1, Math.min(5, Number(body.minHits) || 1));
        return json(autosort(minHits, body.apply === true));
      }
      if (path === "/api/groups" && req.method === "POST") {
        // body: { buckets, special, keywords?, renames?: { [oldName]: newName } }. Renames migrate decisions; a removed group must be empty.
        const body = await req.json() as { buckets: unknown; special: unknown; keywords?: unknown; renames?: Record<string, string> };
        const next = validateGroups(body.buckets, body.special, body.keywords);
        if (typeof next === "string") return json({ error: next }, 400);
        const renames = body.renames && typeof body.renames === "object" ? body.renames : {};
        const counts: Record<string, number> = {};
        for (const d of Object.values(decisions)) { const name = renames[d.bucket] ?? d.bucket; counts[name] = (counts[name] || 0) + 1; }
        const kept = new Set([...next.buckets, ...next.special]);
        const orphan = Object.keys(counts).filter(name => !kept.has(name));
        if (orphan.length) return json({ error: `groups with accounts cannot be removed: ${orphan.map(n => `${n} (${counts[n]})`).join(", ")}` }, 400);
        for (const d of Object.values(decisions)) if (renames[d.bucket]) d.bucket = renames[d.bucket];
        config.buckets = next.buckets; config.special = next.special; config.keywords = next.keywords;
        writeJsonAtomic("config.json", config);
        writeJsonAtomic("decisions.json", decisions);
        return json({ ok: true, buckets: config.buckets, special: config.special, keywords: config.keywords });
      }
      if (path === "/api/open" && req.method === "POST") {
        // Navigates the Instagram window (a read-only action) to a profile or a post.
        const body = await req.json() as { username?: string; code?: string };
        if (!igBlock) igBlock = await findInstagramBlock();
        if (!igBlock) return json({ error: "No Instagram window open in Tern." }, 409);
        if (body.code) {
          if (!/^[\w-]{1,40}$/.test(body.code)) return json({ error: "invalid post code" }, 400);
          await ternOp({ op: "goto", block: igBlock, url: `https://www.instagram.com/p/${body.code}/` });
          return json({ ok: true });
        }
        if (!/^[\w.]{1,40}$/.test(body.username || "")) return json({ error: "invalid username" }, 400);
        await ternOp({ op: "goto", block: igBlock, url: `https://www.instagram.com/${body.username}/` });
        return json({ ok: true });
      }
      if (path === "/api/export" && req.method === "POST") return json({ ok: true, files: exportLists() });
      return new Response("not found", { status: 404 });
    } catch (e) {
      return json({ error: String((e as Error).message || e) }, 500);
    }
  },
});

console.log(`insorter at http://127.0.0.1:${server.port}  accounts=${accounts.length} decisions=${Object.keys(decisions).length}${accounts.length ? "" : "  (run \`bun run collect\` first)"}`);
