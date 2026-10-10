// Insorter collect: opens Instagram inside Tern, waits for YOU to log in there, then reads your
// following / followers / pending-requests lists with the web app's own endpoints (read-only).
// Credentials never pass through this process; only usernames, names and avatar URLs are saved.
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { evalIn, findInstagramBlock, openInstagramBlock, TernError } from "./tern";
import { diffAccounts } from "./lib";

const DATA = join(import.meta.dir, "..", "data");
const PAGE = 200;
const GAP_MS = Number(process.env.INSORTER_GAP_MS || 1500);
const LOGIN_TIMEOUT_MS = 20 * 60_000;

type ListUser = { pk: string; username: string; full_name: string; is_private: boolean; is_verified: boolean; pic: string; extra: Record<string, unknown> };
type Account = ListUser & { you_follow: boolean; follows_you: boolean; pending_request: boolean; last_post: number | null; no_posts: boolean | null };

const FN_SESSION = `() => ({ uid: (document.cookie.match(/ds_user_id=(\\d+)/) || [])[1] || null, path: location.pathname })`;

// One page of a friendships list. count/max_id follow the web app; the response is trimmed to what Insorter stores.
const FN_PAGE = `async (path, extra, maxId, count) => {
  const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
  const uid = (document.cookie.match(/ds_user_id=(\\d+)/) || [])[1];
  const url = 'https://www.instagram.com/api/v1/friendships/' + path.replace('{uid}', uid) + '?count=' + count + extra + (maxId ? '&max_id=' + encodeURIComponent(maxId) : '');
  const r = await fetch(url, { headers: { 'x-ig-app-id': '936619743392459', 'x-csrftoken': csrf, 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { return { status: r.status, error: 'non-json' }; }
  if (r.status !== 200) return { status: r.status, error: (j && j.message) || ('http ' + r.status) };
  return { status: 200, next: j.next_max_id || null, users: (j.users || []).map(u => ({
    pk: String(u.pk), username: u.username, full_name: u.full_name || '', is_private: !!u.is_private, is_verified: !!u.is_verified, pic: u.profile_pic_url || '',
    extra: { latest_reel_media: u.latest_reel_media || 0, is_favorite: !!u.is_favorite, has_anonymous_profile_picture: !!u.has_anonymous_profile_picture, is_possible_scammer: !!u.is_possible_scammer }
  })) };
}`;

const sleep = (ms: number) => Bun.sleep(ms);
const log = (msg: string) => console.log(`[insorter] ${msg}`);

async function waitForLogin(block: number): Promise<string> {
  const started = Date.now();
  let told = false;
  while (Date.now() - started < LOGIN_TIMEOUT_MS) {
    let s: { uid: string | null; path: string } | null = null;
    try { s = await evalIn(block, FN_SESSION); } catch (e) { if (e instanceof TernError && e.kind === "not_found") throw new Error("The Instagram window was closed."); }
    if (s?.uid && !/^\/accounts\/|^\/challenge/.test(s.path)) return s.uid;
    if (!told) {
      told = true;
      log("Log in INSIDE THE INSTAGRAM WINDOW that opened in Tern (username, password and 2FA all go there).");
      log("Never type your password in this terminal or in any chat: Insorter never receives or stores it.");
    }
    await sleep(3000);
  }
  throw new Error("Timed out waiting for the login.");
}

type PageResult = { status: number; error?: string; users?: ListUser[]; next?: string | null };
type Checkpoint = { at: string; users: ListUser[]; next: string | null; done: boolean };
const CACHE_FILE = join(DATA, "collect-cache.json");
const CACHE_TTL_MS = 3 * 3600_000;

function readCache(): Record<string, Checkpoint> {
  if (!existsSync(CACHE_FILE)) return {};
  try { return JSON.parse(readFileSync(CACHE_FILE, "utf8")); } catch { return {}; }
}

type Session = { block: number };

// (Re)opens the Instagram window and waits for the session; used at start and whenever the window disappears mid-run.
async function ensureWindow(session: Session, reopen: boolean): Promise<void> {
  if (reopen) log("the Instagram window was closed; opening another one (keep it open while the collection runs)");
  const existing = reopen ? null : await findInstagramBlock();
  session.block = existing ?? await openInstagramBlock();
  log(existing ? `using the Instagram window already open (block ${session.block})` : `Instagram window opened in Tern (block ${session.block})`);
  await waitForLogin(session.block);
}

// Reads one list page by page. Every page is checkpointed, so an interrupted run resumes instead of restarting;
// throttling (429, 5xx or an HTML answer in place of JSON) backs off exponentially instead of failing.
async function fetchList(session: Session, key: string, label: string, path: string, extra: string): Promise<ListUser[]> {
  const cache = readCache();
  const cp = cache[key];
  const fresh = cp && Date.now() - Date.parse(cp.at) < CACHE_TTL_MS;
  if (fresh && cp.done) { log(`${label}: reusing ${cp.users.length} accounts collected ${Math.round((Date.now() - Date.parse(cp.at)) / 60000)} min ago`); return cp.users; }
  const out: ListUser[] = fresh ? cp.users : [];
  let maxId: string | null = fresh ? cp.next : null;
  if (fresh) log(`${label}: resuming from ${out.length} accounts`);
  let backoff = 0;
  while (true) {
    let res: PageResult;
    try { res = await evalIn<PageResult>(session.block, FN_PAGE, [path, extra, maxId, PAGE]); }
    catch (e) { if (e instanceof TernError && e.kind === "not_found") { await ensureWindow(session, true); continue; } throw e; }
    if (res.status === 429 || res.status >= 500 || res.error === "non-json") {
      backoff++;
      if (backoff > 4) throw new Error(`${label}: Instagram keeps refusing (${res.error || res.status}). Wait an hour and run again; progress is saved.`);
      const minutes = 2 ** (backoff - 1);
      log(`${label}: answer ${res.error || res.status} (rate limited); pausing ${minutes} min`);
      await sleep(minutes * 60_000);
      continue;
    }
    if (res.status !== 200 || !res.users) throw new Error(`${label}: ${res.error || "answer " + res.status}. Session expired? Log in inside the Instagram window and run again.`);
    backoff = 0;
    out.push(...res.users);
    maxId = res.next || null;
    const done = !maxId || res.users.length === 0;
    cache[key] = { at: new Date().toISOString(), users: out, next: maxId, done };
    writeJsonAtomic("collect-cache.json", cache);
    log(`${label}: ${out.length} accounts`);
    if (done) return out;
    await sleep(GAP_MS + Math.random() * 600);
  }
}

function writeJsonAtomic(file: string, value: unknown) {
  mkdirSync(DATA, { recursive: true });
  const p = join(DATA, file);
  writeFileSync(p + ".tmp", JSON.stringify(value));
  renameSync(p + ".tmp", p);
}

async function main() {
  const session: Session = { block: 0 };
  await ensureWindow(session, false);
  const uid = await evalIn<{ uid: string }>(session.block, FN_SESSION).then(s => s.uid);
  log(`session detected (account ${uid}); reading the lists (Instagram usually serves followers 25 at a time: count about a minute per 1,000 accounts)`);

  // The "following" list is ranked and shifts between pages; two passes and a union recover the gaps.
  const followingA = await fetchList(session, "following-1", "following (1/2)", "{uid}/following/", "");
  await sleep(GAP_MS);
  const followingB = await fetchList(session, "following-2", "following (2/2)", "{uid}/following/", "");
  await sleep(GAP_MS);
  const followers = await fetchList(session, "followers", "followers", "{uid}/followers/", "&search_surface=follow_list_page");
  await sleep(GAP_MS);
  const pending = await fetchList(session, "pending", "pending requests", "pending/", "");

  const following = new Map<string, ListUser>();
  for (const u of [...followingA, ...followingB]) following.set(u.pk, u);
  const followerSet = new Map(followers.map(u => [u.pk, u]));
  const pendingSet = new Map(pending.map(u => [u.pk, u]));

  const previous = new Map<string, Account>();
  const prevFile = join(DATA, "accounts.json");
  if (existsSync(prevFile)) { try { for (const a of JSON.parse(readFileSync(prevFile, "utf8")) as Account[]) previous.set(a.pk, a); } catch {} }

  const merged = new Map<string, Account>();
  for (const [pk, u] of [...following, ...followerSet, ...pendingSet]) {
    const prev = previous.get(pk);
    merged.set(pk, { ...(merged.get(pk) || {}), ...u, you_follow: following.has(pk), follows_you: followerSet.has(pk), pending_request: pendingSet.has(pk), last_post: prev?.last_post ?? null, no_posts: prev?.no_posts ?? null });
  }
  const accounts = [...merged.values()].sort((a, b) => a.username.localeCompare(b.username));
  // Changes since the previous collection (who unfollowed you, new followers, ...), shown by the UI under "Mudanças".
  const previousMeta = existsSync(join(DATA, "meta.json")) ? JSON.parse(readFileSync(join(DATA, "meta.json"), "utf8")) as { collected_at?: string } : null;
  const now = new Date().toISOString();
  if (previous.size) {
    const d = diffAccounts([...previous.values()], accounts);
    writeJsonAtomic("changes.json", { at: now, previous_at: previousMeta?.collected_at ?? null, ...d });
    log(`changes since the previous collection: ${d.unfollowed_you.length} unfollowed you · ${d.new_followers.length} new followers · ${d.you_unfollowed.length} you unfollowed · ${d.you_followed.length} you followed · ${d.new_requests.length} new requests`);
  }
  writeJsonAtomic("accounts.json", accounts);
  writeJsonAtomic("meta.json", { collected_at: now, uid, following: following.size, followers: followerSet.size, pending: pendingSet.size });
  if (existsSync(CACHE_FILE)) unlinkSync(CACHE_FILE);

  const mutual = accounts.filter(a => a.you_follow && a.follows_you).length;
  log(`done: ${accounts.length} accounts · following ${following.size} · followers ${followerSet.size} · mutual ${mutual} · not following back ${following.size - mutual} · pending requests ${pendingSet.size}`);
  log("now run `bun start` and open http://127.0.0.1:47380/ in a Tern browser pane");
}

main().catch(e => { console.error(`[insorter] error: ${(e as Error).message}`); process.exit(1); });
