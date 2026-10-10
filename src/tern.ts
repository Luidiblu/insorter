// Bridge to the Instagram window running inside Tern (so.stencil.tern).
// Everything goes through `tern browser` ops: Insorter never holds cookies or credentials itself.

export type BlockId = number;

type TernAnswer = { ok?: Record<string, unknown>; error?: { kind: string; message: string } };

export async function ternOp(op: Record<string, unknown>, timeoutSeconds = 40): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(["tern", "browser", JSON.stringify(op), "--timeout", String(timeoutSeconds)], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  let answer: TernAnswer;
  try { answer = JSON.parse(out); } catch { throw new Error("tern browser: unexpected answer: " + out.slice(0, 200)); }
  if (answer.error) throw new TernError(answer.error.kind, answer.error.message);
  return answer.ok ?? {};
}

export class TernError extends Error {
  constructor(public kind: string, message: string) { super(message); }
}

// Runs `fn` (source of a JS function) in the page world of `block`; the promise it returns is awaited by Tern.
export async function evalIn<T>(block: BlockId, fn: string, args: unknown[] = []): Promise<T> {
  const ok = await ternOp({ op: "eval", block, function: fn, args });
  return ok.value as T;
}

export async function findInstagramBlock(): Promise<BlockId | null> {
  const proc = Bun.spawn(["tern", "inspect", "--json"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  let tree: unknown;
  try { tree = JSON.parse(out); } catch { return null; }
  let found: BlockId | null = null;
  const walk = (n: unknown) => {
    if (found !== null) return;
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === "object") {
      const o = n as Record<string, unknown>;
      if (typeof o.browser === "string" && /^https:\/\/(www\.)?instagram\.com/.test(o.browser) && typeof o.id === "number") { found = o.id; return; }
      Object.values(o).forEach(walk);
    }
  };
  walk(tree);
  return found;
}

// Opens an Instagram window as a picture-in-picture over the pane this process runs in (or the focused one).
export async function openInstagramBlock(): Promise<BlockId> {
  const owner = process.env.TERN_PANE ? Number(process.env.TERN_PANE) : "@focused";
  const ok = await ternOp({ op: "open", owner, url: "https://www.instagram.com/" });
  if (typeof ok.block !== "number") throw new Error("tern browser open: no block in answer");
  return ok.block;
}

// Page-side helper source, prepended to functions that call Instagram's own GraphQL endpoint.
// It reuses the web app's modules (tokens and Relay artifacts), so nothing is copied out of the session.
export const GQL_PRELUDE = `
  const gql = async (name, vars) => {
    const q = require(name + '.graphql'); const p = q.params || q.default.params;
    const pv = Object.fromEntries(Object.entries(p.providedVariables || {}).map(([k, m]) => [k, m.get()]));
    const dtsg = require('DTSGInitialData').token, lsd = require('LSD').token, cu = require('CurrentUserInitialData');
    const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
    const jazoest = '2' + Array.from(dtsg).reduce((s, c) => s + c.charCodeAt(0), 0);
    const body = new URLSearchParams({ av: cu.IG_USER_EIMU || '', __a: '1', __comet_req: '7', fb_dtsg: dtsg, jazoest, lsd, __user: '0', fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: name, server_timestamps: 'true', variables: JSON.stringify(Object.assign({}, vars, pv)), doc_id: p.id }).toString();
    const r = await fetch('https://www.instagram.com/graphql/query', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-FB-Friendly-Name': name, 'X-FB-LSD': lsd, 'X-CSRFToken': csrf, 'X-IG-App-ID': '936619743392459' }, body, credentials: 'include' });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { return { status: r.status, error: 'non-json' }; }
    return { status: r.status, data: j.data || null, error: (!j.data && j.errors && j.errors[0] && j.errors[0].message) || null };
  };
`;
