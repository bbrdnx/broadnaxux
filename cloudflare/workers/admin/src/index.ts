/**
 * broadnaxux-admin — serves admin.barbarabroadnax.com.
 *
 * Phase 1 + Phase 2 surface area:
 *
 *   Auth (public)
 *     GET  /                         login page
 *     POST /api/login                password → session cookie
 *     GET  /__health                 DB connectivity probe
 *
 *   Auth required (HTML pages)
 *     GET  /dashboard                index of admin sections
 *     GET  /case-studies             list of all case studies
 *     GET  /case-studies/new         create form
 *     POST /case-studies/new         create
 *     GET  /case-studies/:id         edit form + Monaco body editor
 *     POST /case-studies/:id         save edits
 *     POST /case-studies/:id/delete  delete row
 *     POST /case-studies/:id/publish set status='published'
 *     POST /case-studies/:id/hide    set status='hidden'
 *     POST /case-studies/:id/draft   set status='draft'
 *     POST /case-studies/:id/move    sort_order ±1 (action=up|down)
 *     GET  /content                  list all site_content keys
 *     GET  /content/:key             edit a single key
 *     POST /content/:key             save a single key
 *     GET  /share-links              list of share-links + view counts
 *     GET  /share-links/new          create form
 *     POST /share-links/new          create (multipart)
 *     GET  /share-links/:id          edit form
 *     POST /share-links/:id          save (multipart)
 *     POST /share-links/:id/delete   delete
 *
 *   Auth required (JSON APIs)
 *     POST /api/logout               end session
 *     GET  /api/me                   current session info
 *     POST /api/uploads              multipart upload → R2, returns { key, url }
 *
 * Implementation notes:
 *   - Server-rendered HTML, no SPA. The only JS islands live on the case
 *     study editor (Monaco + meta_items + image upload) and the share-link
 *     composer (case-study picker + reorder list).
 *   - Auth on /api/* routes returns JSON 401; auth on HTML routes redirects
 *     302 → /.
 */

export interface Env {
  DB: D1Database;
  PUBLIC_BUCKET: R2Bucket;
  PRIVATE_BUCKET: R2Bucket;
  ADMIN_PASSWORD_HASH: string;
}

const SESSION_COOKIE = 'broadnaxux_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MIN_FAILED_LOGIN_DELAY_MS = 250;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_UPLOAD_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'video/mp4',
]);
// Application materials (resume / cover letter). Stored in PRIVATE_BUCKET.
const ALLOWED_DOC_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/msword', // .doc (legacy)
]);

// ─── entrypoint ──────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Public routes
    if (path === '/' && (method === 'GET' || method === 'HEAD')) return loginPage();
    if (path === '/__health' && method === 'GET') return handleHealth(env);
    if (path === '/api/login' && method === 'POST') return handleLogin(request, env);

    // Auth required for everything below
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;

    // JSON APIs
    if (path === '/api/logout' && method === 'POST') return handleLogout(env, session);
    if (path === '/api/me' && method === 'GET') {
      return Response.json({ ok: true, session: { created_at: session.created_at, expires_at: session.expires_at } });
    }
    if (path === '/api/uploads' && method === 'POST') return handleUpload(request, env);
    // Application materials → PRIVATE_BUCKET (never public). Download is auth-gated.
    if (path === '/api/app-docs' && method === 'POST') return handleDocUpload(request, env);
    const docMatch = path.match(/^\/app-docs\/(.+)$/);
    if (docMatch && method === 'GET') return serveAppDoc(env, decodeURIComponent(docMatch[1]));

    // HTML pages — case studies
    if (path === '/dashboard' && method === 'GET') return dashboardPage(env);
    if (path === '/case-studies' && method === 'GET') return listCaseStudiesPage(env, url);
    if (path === '/case-studies/new' && method === 'GET') return editCaseStudyPage(env, null, url);
    if (path === '/case-studies/new' && method === 'POST') return saveCaseStudy(request, env, null);

    const csMatch = path.match(/^\/case-studies\/([a-z0-9-]+)(?:\/(delete|publish|hide|draft|move))?$/);
    if (csMatch) {
      const id = csMatch[1];
      const action = csMatch[2];
      if (!action && method === 'GET')  return editCaseStudyPage(env, id, url);
      if (!action && method === 'POST') return saveCaseStudy(request, env, id);
      if (action === 'delete'  && method === 'POST') return deleteCaseStudy(env, id);
      if (action === 'publish' && method === 'POST') return setCaseStudyStatus(env, id, 'published');
      if (action === 'hide'    && method === 'POST') return setCaseStudyStatus(env, id, 'hidden');
      if (action === 'draft'   && method === 'POST') return setCaseStudyStatus(env, id, 'draft');
      if (action === 'move'    && method === 'POST') return moveCaseStudy(request, env, id);
    }

    // /case-studies/:id/versions/{new|:vid}[/delete]
    const csvMatch = path.match(/^\/case-studies\/([a-z0-9-]+)\/versions(?:\/(new|[A-Za-z0-9_-]+))?(?:\/(delete))?$/);
    if (csvMatch) {
      const csId = csvMatch[1];
      const verToken = csvMatch[2];
      const verAction = csvMatch[3];
      if (!verToken && method === 'GET') return editCaseStudyVersionPage(env, csId, null, url);
      if (verToken === 'new' && method === 'GET')  return editCaseStudyVersionPage(env, csId, null, url);
      if (verToken === 'new' && method === 'POST') return saveCaseStudyVersion(request, env, csId, null);
      if (verToken && verToken !== 'new' && !verAction && method === 'GET')  return editCaseStudyVersionPage(env, csId, verToken, url);
      if (verToken && verToken !== 'new' && !verAction && method === 'POST') return saveCaseStudyVersion(request, env, csId, verToken);
      if (verToken && verToken !== 'new' && verAction === 'delete' && method === 'POST') return deleteCaseStudyVersion(env, csId, verToken);
    }

    // HTML pages — companies
    if (path === '/companies' && method === 'GET') return listCompaniesPage(env, url);
    if (path === '/companies/new' && method === 'GET')  return editCompanyPage(env, null, url);
    if (path === '/companies/new' && method === 'POST') return saveCompany(request, env, null);

    const coMatch = path.match(/^\/companies\/([a-z0-9-]+)(?:\/(delete))?$/);
    if (coMatch) {
      const id = coMatch[1];
      const action = coMatch[2];
      if (!action && method === 'GET')  return editCompanyPage(env, id, url);
      if (!action && method === 'POST') return saveCompany(request, env, id);
      if (action === 'delete' && method === 'POST') return deleteCompany(env, id);
    }

    // HTML pages — site content
    if (path === '/content' && method === 'GET') return listContentPage(env, url);
    const contentMatch = path.match(/^\/content\/([a-z0-9_-]+)$/);
    if (contentMatch) {
      const key = contentMatch[1];
      if (method === 'GET')  return editContentPage(env, key, url);
      if (method === 'POST') return saveContent(request, env, key);
    }

    // HTML pages — share-links
    if (path === '/share-links' && method === 'GET') return listShareLinksPage(env, url);
    if (path === '/share-links/new' && method === 'GET')  return editShareLinkPage(env, null, url);
    if (path === '/share-links/new' && method === 'POST') return saveShareLink(request, env, null);

    const slMatch = path.match(/^\/share-links\/([a-zA-Z0-9_-]+)(?:\/(delete|analytics))?$/);
    if (slMatch) {
      const id = slMatch[1];
      const action = slMatch[2];
      if (!action && method === 'GET')  return editShareLinkPage(env, id, url);
      if (!action && method === 'POST') return saveShareLink(request, env, id);
      if (action === 'delete' && method === 'POST') return deleteShareLink(env, id);
      if (action === 'analytics' && method === 'GET') return analyticsShareLinkPage(env, id, url);
    }

    // HTML pages — applications (job tracker)
    if (path === '/applications' && method === 'GET') return listApplicationsPage(env, url);
    if (path === '/applications/new' && method === 'GET')  return editApplicationPage(env, null, url);
    if (path === '/applications/new' && method === 'POST') return saveApplication(request, env, null);

    const appMatch = path.match(/^\/applications\/([a-z0-9-]+)(?:\/(delete))?$/);
    if (appMatch) {
      const id = appMatch[1];
      const action = appMatch[2];
      if (!action && method === 'GET')  return editApplicationPage(env, id, url);
      if (!action && method === 'POST') return saveApplication(request, env, id);
      if (action === 'delete' && method === 'POST') return deleteApplication(env, id);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ─── auth helpers ────────────────────────────────────────────────────────

interface Session { token: string; created_at: number; expires_at: number; last_used_at: number; }

async function requireSession(request: Request, env: Env): Promise<Session | Response> {
  const token = parseCookies(request.headers.get('Cookie') ?? '')[SESSION_COOKIE];
  if (!token) return unauthorized(request);

  const now = nowSeconds();
  const session = await env.DB.prepare(
    'SELECT token, created_at, expires_at, last_used_at FROM admin_sessions WHERE token = ? AND expires_at > ?'
  ).bind(token, now).first<Session>();
  if (!session) return unauthorized(request);

  await env.DB.prepare('UPDATE admin_sessions SET last_used_at = ? WHERE token = ?').bind(now, token).run();
  return session;
}

function unauthorized(request: Request): Response {
  const accept = request.headers.get('Accept') ?? '';
  if (accept.includes('text/html')) {
    return new Response(null, { status: 302, headers: { Location: '/' } });
  }
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  let body: { password?: unknown };
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const password = typeof body.password === 'string' ? body.password : '';
  if (!password) return Response.json({ error: 'Password required' }, { status: 400 });

  const ok = env.ADMIN_PASSWORD_HASH
    ? await verifyPassword(password, env.ADMIN_PASSWORD_HASH).catch(() => false)
    : false;

  if (!ok) {
    await new Promise((r) => setTimeout(r, MIN_FAILED_LOGIN_DELAY_MS));
    return Response.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  const token = randomToken(32);
  const now = nowSeconds();
  const expires = now + SESSION_TTL_SECONDS;
  await env.DB.prepare(
    'INSERT INTO admin_sessions (token, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?)'
  ).bind(token, now, expires, now).run();

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie(token, SESSION_TTL_SECONDS) },
  });
}

async function handleLogout(env: Env, session: Session): Promise<Response> {
  await env.DB.prepare('DELETE FROM admin_sessions WHERE token = ?').bind(session.token).run();
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie('', 0) },
  });
}

function sessionCookie(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(':');
  if (parts.length !== 3) return false;
  const [saltB64, iterStr, hashB64] = parts;
  const salt = base64ToBytes(saltB64);
  const iterations = parseInt(iterStr, 10);
  const expected = base64ToBytes(hashB64);
  if (!iterations || iterations < 1000) return false;

  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      keyMaterial, expected.byteLength * 8
    )
  );
  return constantTimeEqual(derived, expected);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function nowSeconds(): number { return Math.floor(Date.now() / 1000); }

// ─── DB helpers ──────────────────────────────────────────────────────────

interface CaseStudyRow {
  id: string;
  title: string;
  company: string;
  company_id: string | null;
  role: string | null;
  outcome_metric: string | null;
  hero_image_key: string | null;
  hero_fit: string | null; // 'cover' (default) | 'contain' | 'frame'
  hero_pos_x: number | null; // object-position X %, 0-100 (default 50)
  hero_pos_y: number | null; // object-position Y %, 0-100 (default 50)
  hero_image_key_2: string | null; // optional secondary ("mobile") image
  hero_fit_2: string | null; // same values as hero_fit
  hero_pos_x_2: number | null; // object-position X %, 0-100 (default 50)
  hero_pos_y_2: number | null; // object-position Y %, 0-100 (default 50)
  body_html: string;
  status: string;
  sort_order: number;
  subtitle: string | null;
  about_html: string | null;
  meta_items: string | null;
  meta_role: string | null;
  meta_team: string | null;
  meta_rating: string | null;
  kind: string | null;          // 'work' (default) | 'side'
  external_url: string | null;  // live project link (side projects)
  card_only: number | null;     // 1 = "Now building" card links out, no internal page
  live_label: string | null;    // status badge text on the side card (e.g. "Live")
}

async function listCaseStudies(env: Env): Promise<CaseStudyRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, company, company_id, role, outcome_metric, hero_image_key, hero_fit,
            hero_pos_x, hero_pos_y, hero_image_key_2, hero_fit_2, hero_pos_x_2, hero_pos_y_2, body_html,
            status, sort_order, subtitle, about_html, meta_items,
            meta_role, meta_team, meta_rating,
            kind, external_url, card_only, live_label
       FROM case_studies
   ORDER BY sort_order ASC, created_at ASC`
  ).all<CaseStudyRow>();
  return results ?? [];
}

async function getCaseStudy(env: Env, id: string): Promise<CaseStudyRow | null> {
  return env.DB.prepare(
    `SELECT id, title, company, company_id, role, outcome_metric, hero_image_key, hero_fit,
            hero_pos_x, hero_pos_y, hero_image_key_2, hero_fit_2, hero_pos_x_2, hero_pos_y_2, body_html,
            status, sort_order, subtitle, about_html, meta_items,
            meta_role, meta_team, meta_rating,
            kind, external_url, card_only, live_label
       FROM case_studies WHERE id = ?`
  ).bind(id).first<CaseStudyRow>();
}

// ─── data access: companies ──────────────────────────────────────────────

interface CompanyRow {
  id: string;
  name: string;
  logo_image_key: string | null;
  brand_color: string | null;
  sort_order: number;
}

async function listCompanies(env: Env): Promise<CompanyRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, logo_image_key, brand_color, sort_order
       FROM companies ORDER BY sort_order ASC, name ASC`
  ).all<CompanyRow>();
  return results ?? [];
}

async function getCompany(env: Env, id: string): Promise<CompanyRow | null> {
  return env.DB.prepare(
    `SELECT id, name, logo_image_key, brand_color, sort_order FROM companies WHERE id = ?`
  ).bind(id).first<CompanyRow>();
}

interface ContentRow { key: string; value: string; value_type: string; updated_at: number; }

async function listContent(env: Env): Promise<ContentRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT key, value, value_type, updated_at FROM site_content ORDER BY key ASC`
  ).all<ContentRow>();
  return results ?? [];
}

async function getContent(env: Env, key: string): Promise<ContentRow | null> {
  return env.DB.prepare(
    `SELECT key, value, value_type, updated_at FROM site_content WHERE key = ?`
  ).bind(key).first<ContentRow>();
}

// ─── escape ──────────────────────────────────────────────────────────────

function htmlEscape(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function attrEscape(s: unknown): string { return htmlEscape(s); }

// ─── chrome ──────────────────────────────────────────────────────────────

const SHARED_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0D1B1E; color: #E6EBE8; min-height: 100vh; padding: 0; margin: 0; -webkit-font-smoothing: antialiased; }
  a { color: #E2403E; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .topbar { background: #122A2E; border-bottom: 1px solid #1B3A3F; padding: 0.85rem 2rem; display: flex; align-items: center; gap: 2rem; position: sticky; top: 0; z-index: 100; }
  .topbar h1 { font-size: 0.85rem; font-weight: 700; color: #E2403E; letter-spacing: 0.08em; text-transform: uppercase; margin: 0; }
  .topbar nav { display: flex; gap: 1.25rem; flex: 1; }
  .topbar nav a { font-size: 0.78rem; color: #8B9698; letter-spacing: 0.04em; }
  .topbar nav a:hover, .topbar nav a.active { color: #E6EBE8; text-decoration: none; }
  .topbar form { margin: 0; }
  .topbar button { background: transparent; color: #8B9698; border: 1px solid #244549; padding: 0.4rem 0.8rem; border-radius: 4px; font-size: 0.75rem; font-family: inherit; cursor: pointer; }
  .topbar button:hover { color: #E2403E; border-color: #E2403E; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 2.5rem 2rem 4rem; }
  .wrap h2 { font-size: 1.4rem; font-weight: 500; color: #E2403E; letter-spacing: 0.04em; margin: 0 0 0.4rem; }
  .wrap .sub { color: #8B9698; font-size: 0.85rem; margin-bottom: 2rem; }
  .toolbar { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .btn { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.55rem 1rem; background: #E2403E; color: #0D1B1E; font-weight: 600; border-radius: 4px; border: 0; cursor: pointer; font-family: inherit; font-size: 0.85rem; text-decoration: none; }
  .btn:hover { filter: brightness(1.1); text-decoration: none; }
  .btn.secondary { background: transparent; color: #E6EBE8; border: 1px solid #244549; }
  .btn.secondary:hover { border-color: #E2403E; color: #E2403E; }
  .btn.danger { background: transparent; color: #ff6b6b; border: 1px solid #5a2a2a; }
  .btn.danger:hover { background: rgba(255, 107, 107, 0.08); }
  .badge { display: inline-block; font-size: 0.62rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; padding: 0.2rem 0.55rem; border-radius: 100px; }
  .badge.published { background: rgba(132, 252, 168, 0.12); color: #8eecb1; border: 1px solid rgba(132, 252, 168, 0.25); }
  .badge.draft { background: rgba(247,179,43, 0.12); color: #F7B32B; border: 1px solid rgba(247,179,43, 0.25); }
  .badge.hidden { background: rgba(140, 140, 160, 0.12); color: #8B9698; border: 1px solid rgba(140, 140, 160, 0.25); }

  table.list { width: 100%; border-collapse: collapse; background: #122A2E; border-radius: 8px; overflow: hidden; border: 1px solid #1B3A3F; }
  table.list th, table.list td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #1B3A3F; vertical-align: middle; font-size: 0.85rem; }
  table.list th { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.1em; color: #7E8F91; font-weight: 700; background: #163236; }
  table.list tr:last-child td { border-bottom: 0; }
  table.list .actions { display: flex; gap: 0.4rem; flex-wrap: wrap; justify-content: flex-end; }
  table.list .actions form { margin: 0; display: inline; }
  table.list .actions button, table.list .actions a { font-size: 0.7rem; padding: 0.3rem 0.6rem; }
  table.list .small { color: #7E8F91; font-size: 0.78rem; }

  .form-grid { display: grid; gap: 1.1rem; }
  .field { display: flex; flex-direction: column; gap: 0.4rem; }
  .field label { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.1em; color: #7E8F91; font-weight: 700; }
  .field input, .field textarea, .field select { background: #0D1B1E; border: 1px solid #244549; color: #E6EBE8; padding: 0.65rem 0.8rem; border-radius: 4px; font-family: inherit; font-size: 0.9rem; width: 100%; }
  .field textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem; line-height: 1.55; min-height: 8rem; resize: vertical; }
  .field input:focus, .field textarea:focus, .field select:focus { outline: none; border-color: #E2403E; }
  .field .hint { font-size: 0.72rem; color: #7E8F91; }

  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1.1rem; }
  @media (max-width: 720px) { .row2 { grid-template-columns: 1fr; } }

  .toast { position: fixed; bottom: 1.5rem; right: 1.5rem; background: #122A2E; color: #E6EBE8; padding: 0.7rem 1.1rem; border: 1px solid #244549; border-radius: 6px; font-size: 0.85rem; box-shadow: 0 8px 32px rgba(0,0,0,0.4); transition: opacity 0.4s; }
  .toast.success { border-color: rgba(132, 252, 168, 0.4); color: #8eecb1; }
  .toast.error   { border-color: rgba(255, 107, 107, 0.4); color: #ff6b6b; }
`;

function shell(opts: {
  title: string;
  activeNav?: 'dashboard' | 'case-studies' | 'companies' | 'content' | 'share-links' | 'applications';
  body: string;
  extraHead?: string;
  toast?: { kind: 'success' | 'error'; text: string };
  trailingScript?: string;
}): string {
  const navLink = (href: string, label: string, key: string) =>
    `<a href="${href}"${opts.activeNav === key ? ' class="active"' : ''}>${htmlEscape(label)}</a>`;
  const toast = opts.toast
    ? `<div class="toast ${opts.toast.kind}">${htmlEscape(opts.toast.text)}</div>
       <script>setTimeout(() => { const t = document.querySelector('.toast'); if (t) t.style.opacity = '0'; }, 3500);</script>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${htmlEscape(opts.title)} · broadnaxux admin</title>
  <style>${SHARED_CSS}</style>
${opts.extraHead ?? ''}
</head>
<body>
  <header class="topbar">
    <h1>broadnaxux admin</h1>
    <nav>
      ${navLink('/dashboard', 'Dashboard', 'dashboard')}
      ${navLink('/case-studies', 'Case Studies', 'case-studies')}
      ${navLink('/companies', 'Companies', 'companies')}
      ${navLink('/content', 'Site Content', 'content')}
      ${navLink('/share-links', 'Share Links', 'share-links')}
      ${navLink('/applications', 'Applications', 'applications')}
    </nav>
    <form method="POST" action="/api/logout" id="logoutForm">
      <button type="button" id="logoutBtn">Sign out</button>
    </form>
  </header>
  <main class="wrap">
${opts.body}
  </main>
${toast}
  <script>
    document.getElementById('logoutBtn')?.addEventListener('click', async () => {
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
      location.href = '/';
    });
  </script>
${opts.trailingScript ?? ''}
</body>
</html>`;
}

function readToast(url: URL): { kind: 'success' | 'error'; text: string } | undefined {
  const t = url.searchParams.get('toast');
  const k = url.searchParams.get('kind');
  if (!t) return undefined;
  return { kind: k === 'error' ? 'error' : 'success', text: t };
}

function redirectWithToast(url: URL, path: string, kind: 'success' | 'error', text: string): Response {
  const target = new URL(path, url);
  target.searchParams.set('toast', text);
  target.searchParams.set('kind', kind);
  return new Response(null, { status: 303, headers: { Location: target.pathname + target.search } });
}

// ─── pages: dashboard ────────────────────────────────────────────────────

async function dashboardPage(env: Env): Promise<Response> {
  const cs = await env.DB.prepare(
    `SELECT count(*) as total,
            sum(CASE WHEN status='published' THEN 1 ELSE 0 END) as published
       FROM case_studies`
  ).first<{ total: number; published: number }>();
  const cn = await env.DB.prepare(`SELECT count(*) as n FROM site_content`).first<{ n: number }>();
  const co = await safeFirst<{ total: number; withLogo: number }>(env,
    `SELECT count(*) as total,
            sum(CASE WHEN logo_image_key IS NOT NULL AND logo_image_key != '' THEN 1 ELSE 0 END) as withLogo
       FROM companies`);
  const sl = await safeFirst<{ total: number; active: number }>(env,
    `SELECT count(*) as total,
            sum(CASE WHEN expires_at IS NULL OR expires_at > unixepoch() THEN 1 ELSE 0 END) as active
       FROM share_links`);
  const ap = await safeFirst<{ total: number; live: number }>(env,
    `SELECT count(*) as total,
            sum(CASE WHEN status IN ('applied','followed_up','interviewing','offer') THEN 1 ELSE 0 END) as live
       FROM applications`);

  const body = `
    <h2>Dashboard</h2>
    <p class="sub">Edit case studies, homepage content, and share-links.</p>

    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 2rem;">
      <a href="/case-studies" style="background: #122A2E; border: 1px solid #1B3A3F; padding: 1.25rem; border-radius: 8px; text-decoration: none;">
        <div style="font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.1em; color: #7E8F91;">Case Studies</div>
        <div style="font-size: 1.6rem; font-weight: 700; color: #E6EBE8; margin: 0.4rem 0;">${cs?.total ?? 0}</div>
        <div style="color: #8B9698; font-size: 0.78rem;">${cs?.published ?? 0} published</div>
      </a>
      <a href="/companies" style="background: #122A2E; border: 1px solid #1B3A3F; padding: 1.25rem; border-radius: 8px; text-decoration: none;">
        <div style="font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.1em; color: #7E8F91;">Companies</div>
        <div style="font-size: 1.6rem; font-weight: 700; color: #E6EBE8; margin: 0.4rem 0;">${co?.total ?? 0}</div>
        <div style="color: #8B9698; font-size: 0.78rem;">${co?.withLogo ?? 0} with a logo</div>
      </a>
      <a href="/content" style="background: #122A2E; border: 1px solid #1B3A3F; padding: 1.25rem; border-radius: 8px; text-decoration: none;">
        <div style="font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.1em; color: #7E8F91;">Site Content Keys</div>
        <div style="font-size: 1.6rem; font-weight: 700; color: #E6EBE8; margin: 0.4rem 0;">${cn?.n ?? 0}</div>
        <div style="color: #8B9698; font-size: 0.78rem;">homepage copy + ticker</div>
      </a>
      <a href="/share-links" style="background: #122A2E; border: 1px solid #1B3A3F; padding: 1.25rem; border-radius: 8px; text-decoration: none;">
        <div style="font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.1em; color: #7E8F91;">Share Links</div>
        <div style="font-size: 1.6rem; font-weight: 700; color: #E6EBE8; margin: 0.4rem 0;">${sl?.total ?? 0}</div>
        <div style="color: #8B9698; font-size: 0.78rem;">${sl?.active ?? 0} active</div>
      </a>
      <a href="/applications" style="background: #122A2E; border: 1px solid #1B3A3F; padding: 1.25rem; border-radius: 8px; text-decoration: none;">
        <div style="font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.1em; color: #7E8F91;">Applications</div>
        <div style="font-size: 1.6rem; font-weight: 700; color: #E6EBE8; margin: 0.4rem 0;">${ap?.total ?? 0}</div>
        <div style="color: #8B9698; font-size: 0.78rem;">${ap?.live ?? 0} in flight</div>
      </a>
      <a href="https://barbarabroadnax.com/" target="_blank" rel="noopener" style="background: #122A2E; border: 1px solid #1B3A3F; padding: 1.25rem; border-radius: 8px; text-decoration: none;">
        <div style="font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.1em; color: #7E8F91;">Public Site</div>
        <div style="font-size: 1rem; font-weight: 600; color: #E2403E; margin: 0.4rem 0;">view live →</div>
        <div style="color: #8B9698; font-size: 0.78rem;">opens in new tab</div>
      </a>
    </div>

    <div style="background: #122A2E; border: 1px solid #1B3A3F; border-radius: 8px; padding: 1.25rem 1.5rem;">
      <div style="font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; color: #7E8F91; margin-bottom: 0.5rem;">Quick actions</div>
      <ul style="list-style: none; padding: 0; line-height: 2;">
        <li><a href="/case-studies/new">+ New case study</a></li>
        <li><a href="/applications/new">+ New application</a></li>
        <li><a href="/share-links/new">+ New share-link</a></li>
        <li><a href="/case-studies">Manage case studies</a></li>
        <li><a href="/content">Edit homepage content</a></li>
      </ul>
    </div>
  `;
  return new Response(shell({ title: 'Dashboard', activeNav: 'dashboard', body }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

// ─── pages: case studies list ────────────────────────────────────────────

async function listCaseStudiesPage(env: Env, url: URL): Promise<Response> {
  const rows = await listCaseStudies(env);
  const body = `
    <div class="toolbar">
      <h2 style="flex: 1;">Case Studies</h2>
      <a href="/case-studies/new" class="btn">+ New</a>
    </div>
    <p class="sub">Use the up/down arrows to reorder. Drag-and-drop is Phase 2.</p>

    <table class="list">
      <thead>
        <tr>
          <th style="width: 7rem;">#</th>
          <th>Title</th>
          <th>Company</th>
          <th>Status</th>
          <th style="text-align: right;">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r, i) => caseStudyListRow(r, i, rows.length)).join('\n')}
      </tbody>
    </table>
  `;
  return new Response(shell({ title: 'Case Studies', activeNav: 'case-studies', body, toast: readToast(url) }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

function caseStudyListRow(r: CaseStudyRow, idx: number, total: number): string {
  const statusClass = r.status === 'published' ? 'published' : r.status === 'draft' ? 'draft' : 'hidden';
  const actions: string[] = [];
  if (r.status !== 'published') actions.push(`<form method="POST" action="/case-studies/${attrEscape(r.id)}/publish"><button class="btn secondary">Publish</button></form>`);
  if (r.status === 'published') actions.push(`<form method="POST" action="/case-studies/${attrEscape(r.id)}/hide"><button class="btn secondary">Hide</button></form>`);
  if (r.status === 'hidden')    actions.push(`<form method="POST" action="/case-studies/${attrEscape(r.id)}/draft"><button class="btn secondary">Make draft</button></form>`);
  const titleSafeForJs = htmlEscape(r.title).replace(/'/g, "&#39;");
  const isSide = r.kind === 'side';
  const kindTag = isSide ? ` <span class="badge draft" style="margin-left:0.35rem;">side</span>` : '';
  const urlLine = isSide && r.card_only
    ? htmlEscape(r.external_url || '(external link)')
    : `/work/${htmlEscape(r.id)}`;
  return `        <tr>
          <td>
            <div style="display: flex; gap: 0.25rem; align-items: center;">
              <span class="small" style="min-width: 1.2rem;">${r.sort_order}</span>
              <form method="POST" action="/case-studies/${attrEscape(r.id)}/move" style="display:inline; margin: 0;">
                <input type="hidden" name="action" value="up">
                <button class="btn secondary" style="padding: 0.15rem 0.45rem;" ${idx === 0 ? 'disabled' : ''}>↑</button>
              </form>
              <form method="POST" action="/case-studies/${attrEscape(r.id)}/move" style="display:inline; margin: 0;">
                <input type="hidden" name="action" value="down">
                <button class="btn secondary" style="padding: 0.15rem 0.45rem;" ${idx === total - 1 ? 'disabled' : ''}>↓</button>
              </form>
            </div>
          </td>
          <td>
            <a href="/case-studies/${attrEscape(r.id)}" style="font-weight: 600; color: #E6EBE8;">${htmlEscape(r.title)}</a>${kindTag}
            <div class="small">${urlLine}</div>
          </td>
          <td>${htmlEscape(r.company)}</td>
          <td><span class="badge ${statusClass}">${htmlEscape(r.status)}</span></td>
          <td>
            <div class="actions">
              <a href="/case-studies/${attrEscape(r.id)}" class="btn secondary">Edit</a>
              ${actions.join(' ')}
              <form method="POST" action="/case-studies/${attrEscape(r.id)}/delete" onsubmit="return confirm('Delete &quot;${titleSafeForJs}&quot;? This cannot be undone.');">
                <button class="btn danger">Delete</button>
              </form>
            </div>
          </td>
        </tr>`;
}

// ─── pages: case study editor ────────────────────────────────────────────

async function editCaseStudyPage(env: Env, id: string | null, url: URL): Promise<Response> {
  const isNew = id === null;
  const row = isNew ? null : await getCaseStudy(env, id!);
  if (!isNew && !row) return new Response('Not found', { status: 404 });

  const meta = parseMetaItems(row?.meta_items ?? null);
  const metaJson = JSON.stringify(meta);

  // Companies for the logo dropdown. Empty if migration 0008 isn't applied yet.
  const companies = await listCompanies(env);
  const companyOptions = [`<option value="">— none —</option>`]
    .concat(companies.map((c) =>
      `<option value="${attrEscape(c.id)}"${row?.company_id === c.id ? ' selected' : ''}>${htmlEscape(c.name)}</option>`))
    .join('');

  const heroKey = row?.hero_image_key ?? '';
  const heroPreview = heroKey ? (/^(https?:|\/)/.test(heroKey) ? heroKey : publicUploadUrl(heroKey)) : '';
  const heroFit = row?.hero_fit === 'contain' ? 'contain' : row?.hero_fit === 'frame' ? 'frame' : 'cover';
  // Preview box is a fixed rectangle, so 'frame' (which would resize the real
  // frame) is shown like 'contain' here: the whole image, no crop.
  const heroPreviewFit = heroFit === 'cover' ? 'cover' : 'contain';
  const clampPct = (n: number | null | undefined) =>
    Math.max(0, Math.min(100, Math.round(typeof n === 'number' ? n : 50)));
  const heroPosX = clampPct(row?.hero_pos_x);
  const heroPosY = clampPct(row?.hero_pos_y);

  // Secondary ("mobile") image — same treatment as the primary one.
  const heroKey2 = row?.hero_image_key_2 ?? '';
  const heroPreview2 = heroKey2 ? (/^(https?:|\/)/.test(heroKey2) ? heroKey2 : publicUploadUrl(heroKey2)) : '';
  const heroFit2 = row?.hero_fit_2 === 'contain' ? 'contain' : row?.hero_fit_2 === 'frame' ? 'frame' : 'cover';
  const heroPreviewFit2 = heroFit2 === 'cover' ? 'cover' : 'contain';
  const heroPosX2 = clampPct(row?.hero_pos_x_2);
  const heroPosY2 = clampPct(row?.hero_pos_y_2);

  // Side-project ("Now building") fields.
  const kind = row?.kind === 'side' ? 'side' : 'work';
  const externalUrl = row?.external_url ?? '';
  const liveLabel = row?.live_label ?? '';
  const cardOnly = !!row?.card_only;

  // Load versions (existing case studies only). Returns [] if migration 0006
  // hasn't been applied yet, so the versions section just shows empty.
  const versions: CaseStudyVersionRow[] = isNew ? [] : await listCaseStudyVersions(env, id!);
  const versionsBlock = isNew ? '' : renderVersionsSection(row!.id, row!.title, versions);

  const body = `
    <div class="toolbar">
      <a href="/case-studies" class="small" style="color: #8B9698;">← All case studies</a>
    </div>
    <h2>${isNew ? 'New case study' : htmlEscape(row!.title)}</h2>
    <p class="sub">${isNew ? 'Slug is the URL piece (lowercase, hyphens). Pick wisely, it goes into /work/:slug.' : (cardOnly && externalUrl
      ? `Editing <code>${htmlEscape(row!.id)}</code>. Card-only side project — links straight to <a href="${attrEscape(externalUrl)}" target="_blank" rel="noopener">${htmlEscape(externalUrl)}</a> (no internal page).`
      : `Editing <code>${htmlEscape(row!.id)}</code>. Public URL: <a href="https://barbarabroadnax.com/work/${attrEscape(row!.id)}" target="_blank" rel="noopener">/work/${htmlEscape(row!.id)}</a>`)}</p>

    <form method="POST" action="${isNew ? '/case-studies/new' : '/case-studies/' + attrEscape(row!.id)}" id="csForm" class="form-grid">
      <div class="row2">
        <div class="field">
          <label for="id">Slug</label>
          <input id="id" name="id" type="text" required pattern="[a-z0-9][a-z0-9-]*" value="${attrEscape(row?.id ?? '')}" ${isNew ? '' : 'readonly'}>
          <div class="hint">${isNew ? 'lowercase letters, digits, hyphens. Cannot be changed later.' : 'Slug is locked once a case study is created.'}</div>
        </div>
        <div class="field">
          <label for="status">Status</label>
          <select id="status" name="status">
            <option value="draft"     ${row?.status === 'draft' ? 'selected' : ''}>draft</option>
            <option value="published" ${(row?.status ?? 'published') === 'published' ? 'selected' : ''}>published</option>
            <option value="hidden"    ${row?.status === 'hidden' ? 'selected' : ''}>hidden</option>
          </select>
        </div>
      </div>

      <div class="row2">
        <div class="field">
          <label for="kind">Type</label>
          <select id="kind" name="kind">
            <option value="work" ${kind === 'work' ? 'selected' : ''}>Work case study</option>
            <option value="side" ${kind === 'side' ? 'selected' : ''}>Side project (Now building)</option>
          </select>
          <div class="hint">Work studies appear in the main work grid. Side projects appear in the homepage "Now building" section with the same editing controls.</div>
        </div>
        <div class="field"></div>
      </div>

      <div id="sideFields" class="field" style="display:${kind === 'side' ? 'block' : 'none'}; border:1px solid #244549; border-radius:8px; padding:1rem 1.1rem; background:#122A2E;">
        <div style="font-weight:600; color:#E6EBE8; margin-bottom:0.75rem;">Now building card</div>
        <div class="row2">
          <div class="field">
            <label for="external_url">Live site URL</label>
            <input id="external_url" name="external_url" type="url" value="${attrEscape(externalUrl)}" placeholder="https://example.com">
            <div class="hint">The live project link. Shows as "Visit live site" on the case-study page and as the card's "Live ↗" link.</div>
          </div>
          <div class="field">
            <label for="live_label">Card status badge</label>
            <input id="live_label" name="live_label" type="text" value="${attrEscape(liveLabel)}" placeholder="Live">
            <div class="hint">Small badge on the card, e.g. "Live", "Beta", "Coming soon". Blank = no badge.</div>
          </div>
        </div>
        <label style="display:flex; align-items:center; gap:0.5rem; cursor:pointer; margin-top:0.4rem;">
          <input id="card_only" name="card_only" type="checkbox" value="1" ${cardOnly ? 'checked' : ''} style="width:auto;">
          <span>Card links straight to the live site (no internal case-study page)</span>
        </label>
        <div class="hint">Checked: the card opens the live site directly and the project has no /work page (Body HTML can be left empty). Unchecked: the card opens a full case-study page that includes a "Live ↗" link.</div>
      </div>
      <script>
        (function(){
          var k = document.getElementById('kind');
          var s = document.getElementById('sideFields');
          if (k && s) k.addEventListener('change', function(){ s.style.display = k.value === 'side' ? 'block' : 'none'; });
        })();
      </script>

      <div class="row2">
        <div class="field">
          <label for="title">Title</label>
          <input id="title" name="title" type="text" required value="${attrEscape(row?.title ?? '')}">
        </div>
        <div class="field">
          <label for="company">Company (eyebrow)</label>
          <input id="company" name="company" type="text" required value="${attrEscape(row?.company ?? '')}">
        </div>
      </div>

      <div class="row2">
        <div class="field">
          <label for="company_id">Company logo</label>
          <select id="company_id" name="company_id">${companyOptions}</select>
          <div class="hint">Picks the logo + brand color from <a href="/companies">Companies</a>, shown on the homepage card, case-study hero, and share cards. Leave as none to fall back to matching the eyebrow text.</div>
        </div>
        <div class="field"></div>
      </div>

      <div class="row2">
        <div class="field">
          <label for="role">Homepage role label</label>
          <input id="role" name="role" type="text" value="${attrEscape(row?.role ?? '')}">
          <div class="hint">Shown in the homepage work table, e.g. "Lead Product Designer".</div>
        </div>
        <div class="field">
          <label for="outcome_metric">Homepage outcome</label>
          <input id="outcome_metric" name="outcome_metric" type="text" value="${attrEscape(row?.outcome_metric ?? '')}">
          <div class="hint">Short outcome shown in the homepage work table, e.g. "$612K revenue in 6 months".</div>
        </div>
      </div>

      <div class="field">
        <label for="subtitle">Subtitle (lead paragraph in case-hero)</label>
        <textarea id="subtitle" name="subtitle" rows="2">${htmlEscape(row?.subtitle ?? '')}</textarea>
      </div>

      <div class="field">
        <label for="about_html">About company block (HTML, inside .company-context div)</label>
        <textarea id="about_html" name="about_html" rows="4">${htmlEscape(row?.about_html ?? '')}</textarea>
        <div class="hint">Rendered inside &lt;div class="company-context"&gt;…&lt;/div&gt;. Typically a label and one paragraph.</div>
      </div>

      <div class="field">
        <label>Hero meta items</label>
        <div id="metaList"></div>
        <div><button type="button" class="btn secondary" id="addMeta">+ add row</button></div>
        <input type="hidden" name="meta_items" id="meta_items_input" value="${attrEscape(metaJson)}">
        <div class="hint">Rendered as the case-meta block in the hero. Examples: Role / Team / User Rating, or Role / Timeline / Outcome.</div>
      </div>

      <div class="field">
        <label for="hero_image_key">Hero image (desktop)</label>
        <div style="display:flex; gap:1rem; align-items:flex-start; flex-wrap:wrap;">
          <span id="heroPreview" style="display:inline-flex;align-items:center;justify-content:center;width:120px;height:78px;background:#FBFEF9;border-radius:6px;overflow:hidden;border:1px solid #244549;flex-shrink:0;">
            ${heroPreview ? `<img src="${attrEscape(heroPreview)}" alt="" style="width:100%;height:100%;object-fit:${heroPreviewFit};object-position:${heroPosX}% ${heroPosY}%;">` : '<span class="small" style="color:#6A7678;">none</span>'}
          </span>
          <div style="flex:1; min-width:240px;">
            <input type="file" id="heroFile" accept="image/png,image/jpeg,image/webp,image/svg+xml" style="display:none;">
            <button type="button" class="btn secondary" id="heroUploadBtn">Upload hero image</button>
            <button type="button" class="btn secondary" id="heroRemoveBtn" style="margin-left:0.4rem;">Remove</button>
            <input id="hero_image_key" name="hero_image_key" type="text" value="${attrEscape(row?.hero_image_key ?? '')}" placeholder="R2 key or URL" style="margin-top:0.5rem;">
            <div id="heroStatus" class="hint" style="margin-top:0.4rem;">The primary (desktop) image. Shown on the homepage work card and at the top of the case-study page. Uploading fills the field automatically.</div>
            <label for="hero_fit" style="display:block;margin-top:0.7rem;">Image fit</label>
            <select id="hero_fit" name="hero_fit" style="margin-top:0.3rem;">
              <option value="cover"${heroFit === 'cover' ? ' selected' : ''}>Fill frame (crop to 16:10)</option>
              <option value="frame"${heroFit === 'frame' ? ' selected' : ''}>Fit frame to image (no crop, keeps zoom)</option>
              <option value="contain"${heroFit === 'contain' ? ' selected' : ''}>Fit image in 16:10 (letterbox, no zoom)</option>
            </select>
            <div class="hint" style="margin-top:0.4rem;">"Fill" crops the image to a fixed 16:10 frame. "Fit frame to image" sizes the frame to the image's own shape, so nothing is cropped and the ken-burns zoom stays on. "Fit image in 16:10" keeps the 16:10 frame and letterboxes the whole image, with the zoom off.</div>
            <div id="heroPosWrap" style="margin-top:0.8rem;${heroFit !== 'cover' ? 'opacity:0.45;' : ''}">
              <label style="display:block;">Image position <span class="small" style="color:#8B9698;">(only affects "Fill")</span></label>
              <div style="display:flex;align-items:center;gap:0.6rem;margin-top:0.3rem;">
                <span class="small" style="width:5.5rem;color:#8B9698;">Horizontal</span>
                <input id="hero_pos_x" name="hero_pos_x" type="range" min="0" max="100" step="1" value="${heroPosX}" style="flex:1;">
                <span id="hero_pos_x_val" class="small" style="width:3rem;text-align:right;color:#8B9698;">${heroPosX}%</span>
              </div>
              <div style="display:flex;align-items:center;gap:0.6rem;margin-top:0.3rem;">
                <span class="small" style="width:5.5rem;color:#8B9698;">Vertical</span>
                <input id="hero_pos_y" name="hero_pos_y" type="range" min="0" max="100" step="1" value="${heroPosY}" style="flex:1;">
                <span id="hero_pos_y_val" class="small" style="width:3rem;text-align:right;color:#8B9698;">${heroPosY}%</span>
              </div>
              <div class="hint" style="margin-top:0.3rem;">0% horizontal = left edge, 100% = right edge. 0% vertical = top, 100% = bottom. 50/50 is centered. The preview updates as you drag.</div>
            </div>
          </div>
        </div>
      </div>

      <script>
        (function(){
          var btn = document.getElementById('heroUploadBtn');
          var input = document.getElementById('heroFile');
          var status = document.getElementById('heroStatus');
          var keyField = document.getElementById('hero_image_key');
          var preview = document.getElementById('heroPreview');
          var fitSel = document.getElementById('hero_fit');
          var posX = document.getElementById('hero_pos_x');
          var posY = document.getElementById('hero_pos_y');
          var posXVal = document.getElementById('hero_pos_x_val');
          var posYVal = document.getElementById('hero_pos_y_val');
          var posWrap = document.getElementById('heroPosWrap');
          function currentFit(){ return fitSel ? fitSel.value : 'cover'; }
          function previewFit(){ return currentFit() === 'cover' ? 'cover' : 'contain'; }
          function currentPos(){ return (posX ? posX.value : 50) + '% ' + (posY ? posY.value : 50) + '%'; }
          function applyToImg(img){ if (!img) return; img.style.objectFit = previewFit(); img.style.objectPosition = currentPos(); }
          function setPreview(url){ preview.innerHTML = '<img src="' + url + '" alt="" style="width:100%;height:100%;object-fit:' + previewFit() + ';object-position:' + currentPos() + ';">'; }
          function onPos(){
            if (posXVal && posX) posXVal.textContent = posX.value + '%';
            if (posYVal && posY) posYVal.textContent = posY.value + '%';
            applyToImg(preview.querySelector('img'));
          }
          if (posX) posX.addEventListener('input', onPos);
          if (posY) posY.addEventListener('input', onPos);
          if (fitSel) fitSel.addEventListener('change', function(){
            applyToImg(preview.querySelector('img'));
            if (posWrap) posWrap.style.opacity = currentFit() !== 'cover' ? '0.45' : '';
          });
          var removeBtn = document.getElementById('heroRemoveBtn');
          btn.addEventListener('click', function(){ input.click(); });
          if (removeBtn) removeBtn.addEventListener('click', function(){
            keyField.value = '';
            preview.innerHTML = '<span class="small" style="color:#6A7678;">none</span>';
            if (status) status.textContent = 'Image removed. Save to apply.';
          });
          keyField.addEventListener('change', function(){
            var v = keyField.value.trim();
            if (!v) { preview.innerHTML = '<span class="small" style="color:#6A7678;">none</span>'; return; }
            setPreview(/^(https?:|\\/)/.test(v) ? v : 'https://barbarabroadnax.com/uploads/' + v);
          });
          input.addEventListener('change', async function(){
            var f = input.files && input.files[0];
            if (!f) return;
            status.textContent = 'Uploading ' + f.name + '…';
            try {
              var fd = new FormData();
              fd.append('file', f);
              var r = await fetch('/api/uploads', { method: 'POST', body: fd, credentials: 'same-origin' });
              if (!r.ok) { var j = await r.json().catch(function(){return {};}); throw new Error(j.error || ('upload failed: ' + r.status)); }
              var j = await r.json();
              keyField.value = j.key;
              setPreview('https://barbarabroadnax.com/uploads/' + j.key);
              status.textContent = 'Uploaded. Save to apply.';
            } catch (ex) {
              status.textContent = 'Upload failed: ' + (ex.message || ex);
            } finally { input.value = ''; }
          });
        })();
      </script>

      <div class="field">
        <label for="hero_image_key_2">Secondary image (mobile)</label>
        <div style="display:flex; gap:1rem; align-items:flex-start; flex-wrap:wrap;">
          <span id="hero2Preview" style="display:inline-flex;align-items:center;justify-content:center;width:120px;height:78px;background:#FBFEF9;border-radius:6px;overflow:hidden;border:1px solid #244549;flex-shrink:0;">
            ${heroPreview2 ? `<img src="${attrEscape(heroPreview2)}" alt="" style="width:100%;height:100%;object-fit:${heroPreviewFit2};object-position:${heroPosX2}% ${heroPosY2}%;">` : '<span class="small" style="color:#6A7678;">none</span>'}
          </span>
          <div style="flex:1; min-width:240px;">
            <input type="file" id="hero2File" accept="image/png,image/jpeg,image/webp,image/svg+xml" style="display:none;">
            <button type="button" class="btn secondary" id="hero2UploadBtn">Upload secondary image</button>
            <button type="button" class="btn secondary" id="hero2RemoveBtn" style="margin-left:0.4rem;">Remove</button>
            <input id="hero_image_key_2" name="hero_image_key_2" type="text" value="${attrEscape(row?.hero_image_key_2 ?? '')}" placeholder="R2 key or URL" style="margin-top:0.5rem;">
            <div id="hero2Status" class="hint" style="margin-top:0.4rem;">Optional. The mobile companion image. When both images are set, this one floats over the desktop image (as a phone-shaped panel) with a parallax on scroll. If only one of the two images is set, that image just fills the frame on its own. Leave blank to show only the desktop image.</div>
            <label for="hero_fit_2" style="display:block;margin-top:0.7rem;">Image fit</label>
            <select id="hero_fit_2" name="hero_fit_2" style="margin-top:0.3rem;">
              <option value="cover"${heroFit2 === 'cover' ? ' selected' : ''}>Fill frame (crop)</option>
              <option value="frame"${heroFit2 === 'frame' ? ' selected' : ''}>Fit frame to image (no crop, keeps zoom)</option>
              <option value="contain"${heroFit2 === 'contain' ? ' selected' : ''}>Fit image (letterbox, no zoom)</option>
            </select>
            <div class="hint" style="margin-top:0.4rem;">Same options as the desktop image. When this image floats as the phone panel, "Fill" crops it to the panel, "Fit image" shows the whole shot letterboxed.</div>
            <div id="hero2PosWrap" style="margin-top:0.8rem;${heroFit2 !== 'cover' ? 'opacity:0.45;' : ''}">
              <label style="display:block;">Image position <span class="small" style="color:#8B9698;">(only affects "Fill")</span></label>
              <div style="display:flex;align-items:center;gap:0.6rem;margin-top:0.3rem;">
                <span class="small" style="width:5.5rem;color:#8B9698;">Horizontal</span>
                <input id="hero_pos_x_2" name="hero_pos_x_2" type="range" min="0" max="100" step="1" value="${heroPosX2}" style="flex:1;">
                <span id="hero_pos_x_2_val" class="small" style="width:3rem;text-align:right;color:#8B9698;">${heroPosX2}%</span>
              </div>
              <div style="display:flex;align-items:center;gap:0.6rem;margin-top:0.3rem;">
                <span class="small" style="width:5.5rem;color:#8B9698;">Vertical</span>
                <input id="hero_pos_y_2" name="hero_pos_y_2" type="range" min="0" max="100" step="1" value="${heroPosY2}" style="flex:1;">
                <span id="hero_pos_y_2_val" class="small" style="width:3rem;text-align:right;color:#8B9698;">${heroPosY2}%</span>
              </div>
              <div class="hint" style="margin-top:0.3rem;">0% horizontal = left edge, 100% = right edge. 0% vertical = top, 100% = bottom. 50/50 is centered. The preview updates as you drag.</div>
            </div>
          </div>
        </div>
      </div>

      <script>
        (function(){
          var btn = document.getElementById('hero2UploadBtn');
          var input = document.getElementById('hero2File');
          var status = document.getElementById('hero2Status');
          var keyField = document.getElementById('hero_image_key_2');
          var preview = document.getElementById('hero2Preview');
          var removeBtn = document.getElementById('hero2RemoveBtn');
          var fitSel = document.getElementById('hero_fit_2');
          var posX = document.getElementById('hero_pos_x_2');
          var posY = document.getElementById('hero_pos_y_2');
          var posXVal = document.getElementById('hero_pos_x_2_val');
          var posYVal = document.getElementById('hero_pos_y_2_val');
          var posWrap = document.getElementById('hero2PosWrap');
          function currentFit(){ return fitSel ? fitSel.value : 'cover'; }
          function previewFit(){ return currentFit() === 'cover' ? 'cover' : 'contain'; }
          function currentPos(){ return (posX ? posX.value : 50) + '% ' + (posY ? posY.value : 50) + '%'; }
          function applyToImg(img){ if (!img) return; img.style.objectFit = previewFit(); img.style.objectPosition = currentPos(); }
          function setPreview(url){ preview.innerHTML = '<img src="' + url + '" alt="" style="width:100%;height:100%;object-fit:' + previewFit() + ';object-position:' + currentPos() + ';">'; }
          function clearPreview(){ preview.innerHTML = '<span class="small" style="color:#6A7678;">none</span>'; }
          function onPos(){
            if (posXVal && posX) posXVal.textContent = posX.value + '%';
            if (posYVal && posY) posYVal.textContent = posY.value + '%';
            applyToImg(preview.querySelector('img'));
          }
          if (posX) posX.addEventListener('input', onPos);
          if (posY) posY.addEventListener('input', onPos);
          if (fitSel) fitSel.addEventListener('change', function(){
            applyToImg(preview.querySelector('img'));
            if (posWrap) posWrap.style.opacity = currentFit() !== 'cover' ? '0.45' : '';
          });
          btn.addEventListener('click', function(){ input.click(); });
          if (removeBtn) removeBtn.addEventListener('click', function(){
            keyField.value = '';
            clearPreview();
            if (status) status.textContent = 'Image removed. Save to apply.';
          });
          keyField.addEventListener('change', function(){
            var v = keyField.value.trim();
            if (!v) { clearPreview(); return; }
            setPreview(/^(https?:|\\/)/.test(v) ? v : 'https://barbarabroadnax.com/uploads/' + v);
          });
          input.addEventListener('change', async function(){
            var f = input.files && input.files[0];
            if (!f) return;
            status.textContent = 'Uploading ' + f.name + '…';
            try {
              var fd = new FormData();
              fd.append('file', f);
              var r = await fetch('/api/uploads', { method: 'POST', body: fd, credentials: 'same-origin' });
              if (!r.ok) { var j = await r.json().catch(function(){return {};}); throw new Error(j.error || ('upload failed: ' + r.status)); }
              var j = await r.json();
              keyField.value = j.key;
              setPreview('https://barbarabroadnax.com/uploads/' + j.key);
              status.textContent = 'Uploaded. Save to apply.';
            } catch (ex) {
              status.textContent = 'Upload failed: ' + (ex.message || ex);
            } finally { input.value = ''; }
          });
        })();
      </script>

      <div class="field">
        <label>Body HTML</label>
        <div style="display: flex; gap: 0.5rem; margin-bottom: 0.5rem; align-items: center; flex-wrap: wrap;">
          <input type="file" id="imgFile" accept="image/*,video/mp4" style="display: none;">
          <button type="button" class="btn secondary" id="uploadBtn">Upload image / video</button>
          <span id="uploadStatus" class="hint" style="margin: 0;"></span>
        </div>
        <div id="editor" style="height: 540px; border: 1px solid #244549; border-radius: 4px; overflow: hidden;"></div>
        <textarea id="body_html_textarea" name="body_html" style="display:none">${htmlEscape(row?.body_html ?? '')}</textarea>
      </div>

      <div style="display: flex; gap: 0.75rem; align-items: center;">
        <button type="submit" class="btn">${isNew ? 'Create' : 'Save changes'}</button>
        <a href="/case-studies" class="btn secondary">Cancel</a>
      </div>
    </form>

    ${versionsBlock}
  `;

  const monacoSetup = `
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs/editor/editor.main.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs/loader.min.js"></script>
  `;

  const editorScript = `<script>
    require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });
    require(['vs/editor/editor.main'], function () {
      const ta = document.getElementById('body_html_textarea');
      window.csEditor = monaco.editor.create(document.getElementById('editor'), {
        value: ta.value,
        language: 'html',
        theme: 'vs-dark',
        automaticLayout: true,
        wordWrap: 'on',
        fontSize: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
      });
    });

    document.getElementById('csForm').addEventListener('submit', function () {
      if (window.csEditor) {
        document.getElementById('body_html_textarea').value = window.csEditor.getValue();
      }
      document.getElementById('meta_items_input').value = JSON.stringify(currentMetaItems());
    });

    let metaItems = ${metaJson};
    function currentMetaItems() {
      const out = [];
      document.querySelectorAll('#metaList .meta-row').forEach(row => {
        const label = row.querySelector('input[data-k="label"]').value.trim();
        const value = row.querySelector('input[data-k="value"]').value.trim();
        if (label || value) out.push({ label, value });
      });
      return out;
    }
    function renderMetaItems() {
      const list = document.getElementById('metaList');
      list.innerHTML = '';
      metaItems.forEach((m, i) => {
        const row = document.createElement('div');
        row.className = 'meta-row';
        row.style.cssText = 'display: grid; grid-template-columns: 1fr 2fr auto; gap: 0.5rem; margin-bottom: 0.5rem;';
        row.innerHTML =
          '<input type="text" placeholder="Label (e.g. Role)" data-k="label" value="' + escAttr(m.label || '') + '">' +
          '<input type="text" placeholder="Value (e.g. Product Designer)" data-k="value" value="' + escAttr(m.value || '') + '">' +
          '<button type="button" class="btn secondary" data-rm="' + i + '">remove</button>';
        list.appendChild(row);
      });
    }
    function escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    document.getElementById('addMeta').addEventListener('click', () => { metaItems = currentMetaItems(); metaItems.push({ label: '', value: '' }); renderMetaItems(); });
    document.getElementById('metaList').addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.dataset && t.dataset.rm !== undefined) {
        metaItems = currentMetaItems();
        metaItems.splice(parseInt(t.dataset.rm, 10), 1);
        renderMetaItems();
      }
    });
    renderMetaItems();

    const upBtn = document.getElementById('uploadBtn');
    const upInput = document.getElementById('imgFile');
    const upStatus = document.getElementById('uploadStatus');
    upBtn.addEventListener('click', () => upInput.click());
    upInput.addEventListener('change', async () => {
      const f = upInput.files && upInput.files[0];
      if (!f) return;
      upStatus.textContent = 'Uploading ' + f.name + '…';
      try {
        const fd = new FormData();
        fd.append('file', f);
        const r = await fetch('/api/uploads', { method: 'POST', body: fd, credentials: 'same-origin' });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || ('upload failed: ' + r.status));
        }
        const j = await r.json();
        upStatus.textContent = 'Uploaded as /uploads/' + j.key;
        if (window.csEditor) {
          const isVideo = (f.type || '').startsWith('video/');
          const url = '/uploads/' + j.key;
          const tag = isVideo
            ? '<video src="' + url + '" autoplay loop muted playsinline style="display:block;width:100%;height:auto;"></video>'
            : '<img src="' + url + '" alt="">';
          const sel = window.csEditor.getSelection();
          window.csEditor.executeEdits('upload', [{ range: sel, text: tag, forceMoveMarkers: true }]);
          window.csEditor.focus();
        }
      } catch (ex) {
        upStatus.textContent = 'Upload failed: ' + (ex.message || ex);
      } finally {
        upInput.value = '';
      }
    });
  </script>`;

  return new Response(shell({
    title: isNew ? 'New case study' : `Edit ${row!.title}`,
    activeNav: 'case-studies',
    body,
    extraHead: monacoSetup,
    toast: readToast(url),
    trailingScript: editorScript,
  }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

function parseMetaItems(s: string | null): Array<{ label: string; value: string }> {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) return v.map((x: any) => ({ label: String(x?.label ?? ''), value: String(x?.value ?? '') }));
  } catch { /* ignore */ }
  return [];
}

// ─── case study actions ──────────────────────────────────────────────────

async function saveCaseStudy(request: Request, env: Env, idOrNull: string | null): Promise<Response> {
  const url = new URL(request.url);
  const form = await request.formData();
  const id = String(form.get('id') ?? '').trim();
  const title = String(form.get('title') ?? '').trim();
  const company = String(form.get('company') ?? '').trim();
  const company_id = String(form.get('company_id') ?? '').trim() || null;
  const status = String(form.get('status') ?? 'draft');
  const role = String(form.get('role') ?? '');
  const outcome_metric = String(form.get('outcome_metric') ?? '');
  const subtitle = String(form.get('subtitle') ?? '');
  const about_html = String(form.get('about_html') ?? '');
  const hero_image_key = String(form.get('hero_image_key') ?? '');
  const rawFit = String(form.get('hero_fit') ?? 'cover');
  const hero_fit = rawFit === 'contain' ? 'contain' : rawFit === 'frame' ? 'frame' : 'cover';
  const clampPos = (v: string | File | null) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 50;
  };
  const hero_pos_x = clampPos(form.get('hero_pos_x'));
  const hero_pos_y = clampPos(form.get('hero_pos_y'));
  const hero_image_key_2 = String(form.get('hero_image_key_2') ?? '');
  const rawFit2 = String(form.get('hero_fit_2') ?? 'cover');
  const hero_fit_2 = rawFit2 === 'contain' ? 'contain' : rawFit2 === 'frame' ? 'frame' : 'cover';
  const hero_pos_x_2 = clampPos(form.get('hero_pos_x_2'));
  const hero_pos_y_2 = clampPos(form.get('hero_pos_y_2'));
  const body_html = String(form.get('body_html') ?? '');
  const kind = String(form.get('kind') ?? 'work') === 'side' ? 'side' : 'work';
  const external_url = String(form.get('external_url') ?? '').trim() || null;
  const card_only = form.get('card_only') ? 1 : 0;
  const live_label = String(form.get('live_label') ?? '').trim() || null;
  let meta_items_str = String(form.get('meta_items') ?? '[]');
  try { JSON.parse(meta_items_str); } catch { meta_items_str = '[]'; }

  const failPath = idOrNull ? `/case-studies/${idOrNull}` : '/case-studies/new';
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) return redirectWithToast(url, failPath, 'error', 'Slug must be lowercase letters, digits, hyphens.');
  if (!title)    return redirectWithToast(url, failPath, 'error', 'Title is required.');
  if (!company)  return redirectWithToast(url, failPath, 'error', 'Company is required.');
  // Side projects can be card-only (link straight out), so the body may be empty.
  if (!body_html && kind !== 'side') return redirectWithToast(url, failPath, 'error', 'Body HTML cannot be empty.');

  if (idOrNull === null) {
    const max = await env.DB.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM case_studies`).first<{ m: number }>();
    const nextOrder = (max?.m ?? 0) + 1;
    try {
      await env.DB.prepare(
        `INSERT INTO case_studies
           (id, title, company, company_id, role, outcome_metric, hero_image_key, hero_fit,
            hero_pos_x, hero_pos_y, hero_image_key_2, hero_fit_2, hero_pos_x_2, hero_pos_y_2, body_html,
            status, sort_order, subtitle, about_html, meta_items,
            kind, external_url, card_only, live_label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())`
      ).bind(id, title, company, company_id, role, outcome_metric, hero_image_key, hero_fit,
              hero_pos_x, hero_pos_y, hero_image_key_2, hero_fit_2, hero_pos_x_2, hero_pos_y_2, body_html,
              status, nextOrder, subtitle, about_html, meta_items_str,
              kind, external_url, card_only, live_label).run();
    } catch (e: any) {
      return redirectWithToast(url, '/case-studies/new', 'error', `Create failed: ${e.message ?? e}`);
    }
    return redirectWithToast(url, `/case-studies/${id}`, 'success', 'Case study created.');
  }

  await env.DB.prepare(
    `UPDATE case_studies SET
       title = ?, company = ?, company_id = ?, role = ?, outcome_metric = ?, hero_image_key = ?,
       hero_fit = ?, hero_pos_x = ?, hero_pos_y = ?,
       hero_image_key_2 = ?, hero_fit_2 = ?, hero_pos_x_2 = ?, hero_pos_y_2 = ?,
       body_html = ?, status = ?, subtitle = ?,
       about_html = ?, meta_items = ?,
       kind = ?, external_url = ?, card_only = ?, live_label = ?,
       updated_at = unixepoch()
     WHERE id = ?`
  ).bind(title, company, company_id, role, outcome_metric, hero_image_key,
          hero_fit, hero_pos_x, hero_pos_y,
          hero_image_key_2, hero_fit_2, hero_pos_x_2, hero_pos_y_2,
          body_html, status, subtitle, about_html, meta_items_str,
          kind, external_url, card_only, live_label, idOrNull).run();
  return redirectWithToast(url, `/case-studies/${idOrNull}`, 'success', 'Saved.');
}

async function deleteCaseStudy(env: Env, id: string): Promise<Response> {
  await env.DB.prepare(`DELETE FROM case_studies WHERE id = ?`).bind(id).run();
  return new Response(null, { status: 303, headers: { Location: '/case-studies?toast=Deleted&kind=success' } });
}

async function setCaseStudyStatus(env: Env, id: string, status: string): Promise<Response> {
  await env.DB.prepare(
    `UPDATE case_studies SET status = ?, updated_at = unixepoch() WHERE id = ?`
  ).bind(status, id).run();
  return new Response(null, { status: 303, headers: { Location: `/case-studies?toast=Status%20set%20to%20${status}&kind=success` } });
}

async function moveCaseStudy(request: Request, env: Env, id: string): Promise<Response> {
  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  const direction = action === 'up' ? -1 : action === 'down' ? 1 : 0;
  if (direction === 0) return new Response(null, { status: 303, headers: { Location: '/case-studies' } });

  const rows = await env.DB.prepare(
    `SELECT id, sort_order FROM case_studies ORDER BY sort_order ASC, created_at ASC`
  ).all<{ id: string; sort_order: number }>();
  const arr = rows.results ?? [];
  const idx = arr.findIndex((r) => r.id === id);
  if (idx === -1) return new Response(null, { status: 303, headers: { Location: '/case-studies' } });
  const swapWith = idx + direction;
  if (swapWith < 0 || swapWith >= arr.length) return new Response(null, { status: 303, headers: { Location: '/case-studies' } });

  const a = arr[idx];
  const b = arr[swapWith];
  await env.DB.batch([
    env.DB.prepare(`UPDATE case_studies SET sort_order = ?, updated_at = unixepoch() WHERE id = ?`).bind(b.sort_order, a.id),
    env.DB.prepare(`UPDATE case_studies SET sort_order = ?, updated_at = unixepoch() WHERE id = ?`).bind(a.sort_order, b.id),
  ]);
  return new Response(null, { status: 303, headers: { Location: '/case-studies?toast=Reordered&kind=success' } });
}

// ─── case study versions ─────────────────────────────────────────────────
// A version is an alternate cut of a case study. Any field that's NULL on
// the version inherits from the canonical row, so a version can override
// only the subtitle, only the body, or any combination.

interface CaseStudyVersionRow {
  id: string;
  case_study_id: string;
  label: string;
  subtitle: string | null;
  about_html: string | null;
  body_html: string | null;
  meta_items: string | null;
  created_at: number;
  updated_at: number;
}

function newVersionId(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(12)));
}

async function listCaseStudyVersions(env: Env, caseStudyId: string): Promise<CaseStudyVersionRow[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, case_study_id, label, subtitle, about_html, body_html, meta_items, created_at, updated_at
         FROM case_study_versions
        WHERE case_study_id = ?
        ORDER BY created_at DESC`
    ).bind(caseStudyId).all<CaseStudyVersionRow>();
    return results ?? [];
  } catch {
    // Migration 0006 not applied yet
    return [];
  }
}

async function getCaseStudyVersion(env: Env, caseStudyId: string, versionId: string): Promise<CaseStudyVersionRow | null> {
  try {
    return await env.DB.prepare(
      `SELECT id, case_study_id, label, subtitle, about_html, body_html, meta_items, created_at, updated_at
         FROM case_study_versions
        WHERE id = ? AND case_study_id = ?`
    ).bind(versionId, caseStudyId).first<CaseStudyVersionRow>();
  } catch {
    return null;
  }
}

async function editCaseStudyVersionPage(
  env: Env,
  caseStudyId: string,
  versionId: string | null,
  url: URL,
): Promise<Response> {
  const cs = await getCaseStudy(env, caseStudyId);
  if (!cs) return new Response('Parent case study not found', { status: 404 });

  const isNew = versionId === null;
  let row: CaseStudyVersionRow | null = null;
  if (!isNew) {
    row = await getCaseStudyVersion(env, caseStudyId, versionId!);
    if (!row) return new Response('Version not found', { status: 404 });
  }

  const meta = parseMetaItems(row?.meta_items ?? null);
  const metaJson = JSON.stringify(meta);
  const inheritsBadge = (val: string | null | undefined) => val == null
    ? '<span style="background:rgba(124,109,144,0.15);color:#7E8F91;font-size:0.55rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:0.15rem 0.4rem;border-radius:100px;margin-left:0.4rem;">inherits</span>'
    : '<span style="background:rgba(226,64,62,0.12);color:#E2403E;font-size:0.55rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:0.15rem 0.4rem;border-radius:100px;margin-left:0.4rem;">override</span>';

  const previewUrl = isNew
    ? ''
    : `https://barbarabroadnax.com/work/${attrEscape(cs.id)}?v=${attrEscape(row!.id)}`;

  const body = `
    <div class="toolbar">
      <a href="/case-studies/${attrEscape(cs.id)}" class="small" style="color:#8B9698;">← ${htmlEscape(cs.title)}</a>
    </div>
    <h2>${isNew ? 'New version' : htmlEscape(row!.label)} <span style="color:#7E8F91;font-weight:400;">— variant of ${htmlEscape(cs.title)}</span></h2>
    <p class="sub">A version overrides individual fields on the canonical case study. Leave a field blank to inherit from the canonical version. Visible at <code>/work/${htmlEscape(cs.id)}?v=&lt;id&gt;</code> and selectable inside share-links.</p>

    ${isNew ? '' : `
    <div style="background:#122A2E;border:1px solid #1B3A3F;border-radius:6px;padding:0.85rem 1.1rem;margin-bottom:1.5rem;display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:0.6rem;text-transform:uppercase;letter-spacing:0.1em;color:#7E8F91;margin-bottom:0.25rem;">Variant URL</div>
        <code style="color:#E2403E;font-size:0.82rem;word-break:break-all;">${htmlEscape(previewUrl)}</code>
      </div>
      <button type="button" class="btn secondary" data-copy="${attrEscape(previewUrl)}">Copy</button>
      <a href="${attrEscape(previewUrl)}" target="_blank" rel="noopener" class="btn secondary">Open ↗</a>
    </div>`}

    <form method="POST" action="${isNew ? `/case-studies/${attrEscape(cs.id)}/versions/new` : `/case-studies/${attrEscape(cs.id)}/versions/${attrEscape(row!.id)}`}" id="vForm" class="form-grid">
      <div class="field">
        <label for="label">Version label *</label>
        <input id="label" name="label" type="text" required maxlength="80" value="${attrEscape(row?.label ?? '')}" placeholder="e.g. Stripe cut, Compliance angle">
        <div class="hint">Admin-only. Helps you find this version when assigning it to a share-link.</div>
      </div>

      <div class="field">
        <label for="subtitle">Subtitle ${inheritsBadge(row?.subtitle)}</label>
        <textarea id="subtitle" name="subtitle" rows="2" placeholder="Leave blank to inherit from the canonical case study.">${htmlEscape(row?.subtitle ?? '')}</textarea>
        <div class="hint">Canonical: <code style="color:#7E8F91;">${htmlEscape((cs.subtitle ?? '').slice(0, 200) || '(empty)')}</code></div>
      </div>

      <div class="field">
        <label for="about_html">About company block ${inheritsBadge(row?.about_html)}</label>
        <textarea id="about_html" name="about_html" rows="4" placeholder="Leave blank to inherit.">${htmlEscape(row?.about_html ?? '')}</textarea>
      </div>

      <div class="field">
        <label>Hero meta items ${inheritsBadge(row?.meta_items)}</label>
        <div id="metaList"></div>
        <div style="display:flex;gap:0.5rem;align-items:center;">
          <button type="button" class="btn secondary" id="addMeta">+ add row</button>
          <button type="button" class="btn secondary" id="clearMeta">Inherit (clear all)</button>
        </div>
        <input type="hidden" name="meta_items" id="meta_items_input" value="${attrEscape(metaJson)}">
        <input type="hidden" name="meta_items_inherit" id="meta_items_inherit" value="${row?.meta_items == null ? '1' : '0'}">
        <div class="hint">Empty list = inherit canonical meta. Add at least one row to override.</div>
      </div>

      <div class="field">
        <label>Body HTML ${inheritsBadge(row?.body_html)}</label>
        <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;align-items:center;flex-wrap:wrap;">
          <input type="file" id="imgFile" accept="image/*,video/mp4" style="display:none;">
          <button type="button" class="btn secondary" id="uploadBtn">Upload image / video</button>
          <button type="button" class="btn secondary" id="loadCanonical">Load canonical body as starting point</button>
          <button type="button" class="btn secondary" id="clearBody">Clear (inherit)</button>
          <span id="uploadStatus" class="hint" style="margin:0;"></span>
        </div>
        <div id="editor" style="height:480px;border:1px solid #244549;border-radius:4px;overflow:hidden;"></div>
        <textarea id="body_html_textarea" name="body_html" style="display:none">${htmlEscape(row?.body_html ?? '')}</textarea>
        <div class="hint">Empty = inherit canonical body. Use "Load canonical" to start from a copy.</div>
      </div>

      <div style="display:flex;gap:0.75rem;align-items:center;">
        <button type="submit" class="btn">${isNew ? 'Create version' : 'Save changes'}</button>
        <a href="/case-studies/${attrEscape(cs.id)}" class="btn secondary">Cancel</a>
        ${isNew ? '' : `<form method="POST" action="/case-studies/${attrEscape(cs.id)}/versions/${attrEscape(row!.id)}/delete" style="display:inline;margin-left:auto;" onsubmit="return confirm('Delete this version? Any share-link mapping will silently fall back to the canonical case study.');">
          <button type="submit" class="btn danger">Delete version</button>
        </form>`}
      </div>
    </form>
  `;

  const monacoSetup = `
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs/editor/editor.main.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs/loader.min.js"></script>
  `;

  const canonicalBodyJson = JSON.stringify(cs.body_html ?? '');

  const editorScript = `<script>
    const CANONICAL_BODY = ${canonicalBodyJson};
    require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });
    require(['vs/editor/editor.main'], function () {
      const ta = document.getElementById('body_html_textarea');
      window.csEditor = monaco.editor.create(document.getElementById('editor'), {
        value: ta.value,
        language: 'html',
        theme: 'vs-dark',
        automaticLayout: true,
        wordWrap: 'on',
        fontSize: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
      });
    });

    document.getElementById('vForm').addEventListener('submit', function () {
      if (window.csEditor) {
        document.getElementById('body_html_textarea').value = window.csEditor.getValue();
      }
      // If meta list is empty AND inherit hasn't been explicitly toggled to 0,
      // mark as inherit. The user-facing "Inherit (clear all)" button sets it.
      const items = currentMetaItems();
      document.getElementById('meta_items_input').value = JSON.stringify(items);
      // If list is empty, default to inherit (sends NULL to DB)
      if (items.length === 0) {
        document.getElementById('meta_items_inherit').value = '1';
      } else {
        document.getElementById('meta_items_inherit').value = '0';
      }
    });

    document.getElementById('loadCanonical').addEventListener('click', () => {
      if (!window.csEditor) return;
      if (window.csEditor.getValue().trim() && !confirm('Replace current body with the canonical body?')) return;
      window.csEditor.setValue(CANONICAL_BODY);
    });
    document.getElementById('clearBody').addEventListener('click', () => {
      if (!window.csEditor) return;
      if (window.csEditor.getValue().trim() && !confirm('Clear body? Empty body means this version inherits the canonical body.')) return;
      window.csEditor.setValue('');
    });

    let metaItems = ${metaJson};
    function currentMetaItems() {
      const out = [];
      document.querySelectorAll('#metaList .meta-row').forEach(row => {
        const label = row.querySelector('input[data-k="label"]').value.trim();
        const value = row.querySelector('input[data-k="value"]').value.trim();
        if (label || value) out.push({ label, value });
      });
      return out;
    }
    function renderMetaItems() {
      const list = document.getElementById('metaList');
      list.innerHTML = '';
      metaItems.forEach((m, i) => {
        const row = document.createElement('div');
        row.className = 'meta-row';
        row.style.cssText = 'display:grid;grid-template-columns:1fr 2fr auto;gap:0.5rem;margin-bottom:0.5rem;';
        row.innerHTML =
          '<input type="text" placeholder="Label" data-k="label" value="' + escAttr(m.label || '') + '">' +
          '<input type="text" placeholder="Value" data-k="value" value="' + escAttr(m.value || '') + '">' +
          '<button type="button" class="btn secondary" data-rm="' + i + '">remove</button>';
        list.appendChild(row);
      });
    }
    function escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    document.getElementById('addMeta').addEventListener('click', () => { metaItems = currentMetaItems(); metaItems.push({ label: '', value: '' }); renderMetaItems(); });
    document.getElementById('clearMeta').addEventListener('click', () => { metaItems = []; renderMetaItems(); });
    document.getElementById('metaList').addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.dataset && t.dataset.rm !== undefined) {
        metaItems = currentMetaItems();
        metaItems.splice(parseInt(t.dataset.rm, 10), 1);
        renderMetaItems();
      }
    });
    renderMetaItems();

    // Copy buttons (variant URL)
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.dataset && t.dataset.copy !== undefined) {
        navigator.clipboard.writeText(t.dataset.copy).then(() => {
          const original = t.textContent; t.textContent = 'Copied'; setTimeout(() => { t.textContent = original; }, 1200);
        }).catch(() => {});
      }
    });

    // Upload — same flow as the canonical editor
    const upBtn = document.getElementById('uploadBtn');
    const upInput = document.getElementById('imgFile');
    const upStatus = document.getElementById('uploadStatus');
    upBtn.addEventListener('click', () => upInput.click());
    upInput.addEventListener('change', async () => {
      const f = upInput.files && upInput.files[0];
      if (!f) return;
      upStatus.textContent = 'Uploading ' + f.name + '…';
      try {
        const fd = new FormData();
        fd.append('file', f);
        const r = await fetch('/api/uploads', { method: 'POST', body: fd, credentials: 'same-origin' });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || ('upload failed: ' + r.status));
        }
        const j = await r.json();
        upStatus.textContent = 'Uploaded as /uploads/' + j.key;
        if (window.csEditor) {
          const isVideo = (f.type || '').startsWith('video/');
          const url = '/uploads/' + j.key;
          const tag = isVideo
            ? '<video src="' + url + '" autoplay loop muted playsinline style="display:block;width:100%;height:auto;"></video>'
            : '<img src="' + url + '" alt="">';
          const sel = window.csEditor.getSelection();
          window.csEditor.executeEdits('upload', [{ range: sel, text: tag, forceMoveMarkers: true }]);
          window.csEditor.focus();
        }
      } catch (ex) {
        upStatus.textContent = 'Upload failed: ' + (ex.message || ex);
      } finally {
        upInput.value = '';
      }
    });
  </script>`;

  return new Response(shell({
    title: isNew ? `New version of ${cs.title}` : `${row!.label} — version of ${cs.title}`,
    activeNav: 'case-studies',
    body,
    extraHead: monacoSetup,
    toast: readToast(url),
    trailingScript: editorScript,
  }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

async function saveCaseStudyVersion(
  request: Request,
  env: Env,
  caseStudyId: string,
  versionIdOrNull: string | null,
): Promise<Response> {
  const url = new URL(request.url);
  const failPath = versionIdOrNull
    ? `/case-studies/${caseStudyId}/versions/${versionIdOrNull}`
    : `/case-studies/${caseStudyId}/versions/new`;

  const cs = await getCaseStudy(env, caseStudyId);
  if (!cs) return redirectWithToast(url, '/case-studies', 'error', 'Parent case study not found.');

  const form = await request.formData();
  const label = String(form.get('label') ?? '').trim();
  if (!label) return redirectWithToast(url, failPath, 'error', 'Version label is required.');

  // Text fields: empty string → NULL = inherit. Non-empty = override.
  function nullIfEmpty(s: string): string | null {
    return s.trim().length === 0 ? null : s;
  }
  const subtitle = nullIfEmpty(String(form.get('subtitle') ?? ''));
  const about_html = nullIfEmpty(String(form.get('about_html') ?? ''));
  const body_html = nullIfEmpty(String(form.get('body_html') ?? ''));

  // meta_items: respect explicit inherit flag. Empty list = inherit.
  const metaInherit = String(form.get('meta_items_inherit') ?? '0') === '1';
  let meta_items: string | null = null;
  if (!metaInherit) {
    let raw = String(form.get('meta_items') ?? '[]');
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) meta_items = JSON.stringify(parsed);
    } catch { meta_items = null; }
  }

  if (versionIdOrNull === null) {
    const id = newVersionId();
    try {
      await env.DB.prepare(
        `INSERT INTO case_study_versions
           (id, case_study_id, label, subtitle, about_html, body_html, meta_items, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())`
      ).bind(id, caseStudyId, label, subtitle, about_html, body_html, meta_items).run();
    } catch (e: any) {
      return redirectWithToast(url, failPath, 'error', `Create failed: ${e?.message ?? e}`);
    }
    return redirectWithToast(url, `/case-studies/${caseStudyId}/versions/${id}`, 'success', 'Version created.');
  }

  const existing = await getCaseStudyVersion(env, caseStudyId, versionIdOrNull);
  if (!existing) return redirectWithToast(url, `/case-studies/${caseStudyId}`, 'error', 'Version not found.');

  await env.DB.prepare(
    `UPDATE case_study_versions
        SET label = ?, subtitle = ?, about_html = ?, body_html = ?, meta_items = ?, updated_at = unixepoch()
      WHERE id = ? AND case_study_id = ?`
  ).bind(label, subtitle, about_html, body_html, meta_items, versionIdOrNull, caseStudyId).run();

  return redirectWithToast(url, failPath, 'success', 'Saved.');
}

function renderVersionsSection(csId: string, csTitle: string, versions: CaseStudyVersionRow[]): string {
  const rows = versions.map((v) => {
    const overrides: string[] = [];
    if (v.subtitle != null)   overrides.push('subtitle');
    if (v.about_html != null) overrides.push('about');
    if (v.body_html != null)  overrides.push('body');
    if (v.meta_items != null) overrides.push('meta');
    const overrideLabel = overrides.length ? overrides.join(' · ') : '<span style="color:#7E8F91;">no overrides — pure inherit</span>';
    const updated = formatTimestamp(v.updated_at);
    const previewUrl = `https://barbarabroadnax.com/work/${csId}?v=${v.id}`;
    return `      <tr>
        <td><a href="/case-studies/${attrEscape(csId)}/versions/${attrEscape(v.id)}" style="font-weight:600;color:#E6EBE8;">${htmlEscape(v.label)}</a></td>
        <td class="small">${overrideLabel}</td>
        <td class="small" style="color:#7E8F91;">${htmlEscape(updated)}</td>
        <td>
          <div class="actions">
            <a href="${attrEscape(previewUrl)}" target="_blank" rel="noopener" class="btn secondary">Preview ↗</a>
            <a href="/case-studies/${attrEscape(csId)}/versions/${attrEscape(v.id)}" class="btn secondary">Edit</a>
          </div>
        </td>
      </tr>`;
  }).join('\n');

  const empty = versions.length === 0
    ? `<p class="sub" style="color:#7E8F91;margin:0.5rem 0 1rem;">No versions yet. Create one to send a tailored cut of <em>${htmlEscape(csTitle)}</em> via a share-link without forking the canonical page.</p>`
    : '';

  return `
    <div style="margin-top:3rem;border-top:1px solid #1B3A3F;padding-top:2rem;">
      <div class="toolbar" style="margin-bottom:0.75rem;">
        <h3 style="margin:0;font-size:1rem;color:#E6EBE8;">Versions of this case study</h3>
        <a href="/case-studies/${attrEscape(csId)}/versions/new" class="btn">+ New version</a>
      </div>
      ${empty}
      ${versions.length ? `<table class="list">
        <thead><tr><th>Label</th><th>Overrides</th><th>Updated</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : ''}
    </div>`;
}

async function deleteCaseStudyVersion(env: Env, caseStudyId: string, versionId: string): Promise<Response> {
  const existing = await getCaseStudyVersion(env, caseStudyId, versionId);
  if (!existing) {
    return new Response(null, { status: 303, headers: { Location: `/case-studies/${caseStudyId}?toast=Version%20not%20found&kind=error` } });
  }
  await env.DB.prepare(`DELETE FROM case_study_versions WHERE id = ? AND case_study_id = ?`)
    .bind(versionId, caseStudyId).run();
  return new Response(null, { status: 303, headers: { Location: `/case-studies/${caseStudyId}?toast=Version%20deleted&kind=success` } });
}

// ─── pages: companies ────────────────────────────────────────────────────

// Logos live in PUBLIC_BUCKET and are served by the public site at /uploads/.
// Admin previews point at the live domain since the admin worker doesn't proxy R2.
function publicUploadUrl(key: string): string {
  return `https://barbarabroadnax.com/uploads/${key}`;
}

function companySlug(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

async function listCompaniesPage(env: Env, url: URL): Promise<Response> {
  const rows = await listCompanies(env);
  const body = `
    <div class="toolbar">
      <h2 style="flex: 1;">Companies</h2>
      <a href="/companies/new" class="btn">+ New</a>
    </div>
    <p class="sub">Upload one logo and brand color per company. Used on homepage cards, case-study heroes, and share-link cards.</p>

    <table class="list">
      <thead>
        <tr>
          <th style="width: 4rem;">Logo</th>
          <th>Name</th>
          <th>Brand</th>
          <th>Slug</th>
          <th style="text-align: right;">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows.length === 0
          ? `<tr><td colspan="5" class="small" style="padding: 1.5rem; text-align: center; color: #7E8F91;">No companies yet. <a href="/companies/new">Add one</a>.</td></tr>`
          : rows.map((r) => {
          const logoCell = r.logo_image_key
            ? `<img src="${attrEscape(publicUploadUrl(r.logo_image_key))}" alt="" style="width: 34px; height: 34px; object-fit: contain; background: #FBFEF9; border-radius: 6px; padding: 3px;">`
            : `<span class="small" style="color: #6A7678;">—</span>`;
          const swatch = r.brand_color
            ? `<span style="display:inline-flex;align-items:center;gap:0.4rem;"><span style="width:14px;height:14px;border-radius:3px;background:${attrEscape(r.brand_color)};display:inline-block;border:1px solid #244549;"></span><span class="small">${htmlEscape(r.brand_color)}</span></span>`
            : `<span class="small" style="color: #6A7678;">—</span>`;
          return `<tr>
            <td>${logoCell}</td>
            <td><a href="/companies/${attrEscape(r.id)}" style="font-weight: 600; color: #E6EBE8;">${htmlEscape(r.name)}</a></td>
            <td>${swatch}</td>
            <td class="small">${htmlEscape(r.id)}</td>
            <td style="text-align: right;"><a href="/companies/${attrEscape(r.id)}" class="btn secondary">Edit</a></td>
          </tr>`;
        }).join('\n')}
      </tbody>
    </table>
  `;
  return new Response(shell({ title: 'Companies', activeNav: 'companies', body, toast: readToast(url) }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

async function editCompanyPage(env: Env, id: string | null, url: URL): Promise<Response> {
  const row = id ? await getCompany(env, id) : null;
  if (id && !row) return new Response('Not found', { status: 404 });
  const isNew = !row;
  const previewUrl = row?.logo_image_key ? publicUploadUrl(row.logo_image_key) : '';

  const body = `
    <div class="toolbar">
      <a href="/companies" class="small" style="color: #8B9698;">← All companies</a>
    </div>
    <h2>${isNew ? 'New company' : htmlEscape(row!.name)}</h2>
    <p class="sub">${isNew ? 'The name must match the Company field on the case studies it applies to.' : `Editing <code>${htmlEscape(row!.id)}</code>.`}</p>

    <form method="POST" action="${isNew ? '/companies/new' : `/companies/${attrEscape(row!.id)}`}" class="form-grid">
      <div class="row2">
        <div class="field">
          <label for="name">Company name</label>
          <input id="name" name="name" type="text" required value="${attrEscape(row?.name ?? '')}" placeholder="IPRO">
          <div class="hint">Shown as the eyebrow. Must match the case study's Company text.</div>
        </div>
        <div class="field">
          <label for="slug">Slug</label>
          <input id="slug" name="slug" type="text" value="${attrEscape(row?.id ?? '')}" ${isNew ? '' : 'readonly'} placeholder="ipro">
          <div class="hint">${isNew ? 'Leave blank to auto-generate from the name.' : 'Fixed after creation.'}</div>
        </div>
      </div>

      <div class="row2">
        <div class="field">
          <label for="brand_color">Brand color</label>
          <div style="display:flex; gap:0.5rem; align-items:center;">
            <input id="brand_color_picker" type="color" value="${attrEscape(row?.brand_color || '#0D1B1E')}" style="width:42px;height:38px;padding:2px;background:#122A2E;border:1px solid #244549;border-radius:4px;">
            <input id="brand_color" name="brand_color" type="text" value="${attrEscape(row?.brand_color ?? '')}" placeholder="#127475" style="flex:1;">
          </div>
          <div class="hint">Tints the logo chip background. Hex, e.g. #127475.</div>
        </div>
        <div class="field">
          <label for="sort_order">Sort order</label>
          <input id="sort_order" name="sort_order" type="number" value="${row?.sort_order ?? 0}">
        </div>
      </div>

      <div class="field">
        <label>Logo</label>
        <div style="display:flex; gap:1rem; align-items:center; flex-wrap:wrap;">
          <span id="logoPreview" style="display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;background:#FBFEF9;border-radius:8px;padding:6px;border:1px solid #244549;">
            ${previewUrl ? `<img src="${attrEscape(previewUrl)}" alt="" style="width:100%;height:100%;object-fit:contain;">` : '<span class="small" style="color:#6A7678;">none</span>'}
          </span>
          <div>
            <input type="file" id="logoFile" accept="image/png,image/svg+xml,image/jpeg,image/webp" style="display:none;">
            <button type="button" class="btn secondary" id="logoUploadBtn">Upload logo</button>
            <div id="logoStatus" class="hint" style="margin-top:0.4rem;">PNG or SVG with transparent background works best.</div>
          </div>
        </div>
        <input type="hidden" id="logo_image_key" name="logo_image_key" value="${attrEscape(row?.logo_image_key ?? '')}">
      </div>

      <div style="display: flex; gap: 0.75rem; align-items: center;">
        <button type="submit" class="btn">${isNew ? 'Create' : 'Save changes'}</button>
        <a href="/companies" class="btn secondary">Cancel</a>
        ${isNew ? '' : `<button type="submit" formaction="/companies/${attrEscape(row!.id)}/delete" formmethod="POST" class="btn secondary" style="margin-left:auto;color:#ff8585;border-color:#5a2a2a;" onclick="return confirm('Delete this company? Its case studies stay but lose the logo link.');">Delete</button>`}
      </div>
    </form>

    <script>
      (function(){
        var picker = document.getElementById('brand_color_picker');
        var hex = document.getElementById('brand_color');
        if (picker && hex) {
          picker.addEventListener('input', function(){ hex.value = picker.value; });
          hex.addEventListener('input', function(){ if (/^#[0-9a-fA-F]{6}$/.test(hex.value)) picker.value = hex.value; });
        }
        var btn = document.getElementById('logoUploadBtn');
        var input = document.getElementById('logoFile');
        var status = document.getElementById('logoStatus');
        var keyField = document.getElementById('logo_image_key');
        var preview = document.getElementById('logoPreview');
        btn.addEventListener('click', function(){ input.click(); });
        input.addEventListener('change', async function(){
          var f = input.files && input.files[0];
          if (!f) return;
          status.textContent = 'Uploading ' + f.name + '…';
          try {
            var fd = new FormData();
            fd.append('file', f);
            var r = await fetch('/api/uploads', { method: 'POST', body: fd, credentials: 'same-origin' });
            if (!r.ok) { var j = await r.json().catch(function(){return {};}); throw new Error(j.error || ('upload failed: ' + r.status)); }
            var j = await r.json();
            keyField.value = j.key;
            preview.innerHTML = '<img src="https://barbarabroadnax.com/uploads/' + j.key + '" alt="" style="width:100%;height:100%;object-fit:contain;">';
            status.textContent = 'Uploaded. Save to apply.';
          } catch (ex) {
            status.textContent = 'Upload failed: ' + (ex.message || ex);
          } finally { input.value = ''; }
        });
      })();
    </script>
  `;
  return new Response(shell({ title: isNew ? 'New company' : `Edit ${row!.name}`, activeNav: 'companies', body, toast: readToast(url) }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

async function saveCompany(request: Request, env: Env, id: string | null): Promise<Response> {
  const url = new URL(request.url);
  const form = await request.formData();
  const name = String(form.get('name') ?? '').trim();
  const brandRaw = String(form.get('brand_color') ?? '').trim();
  const logo_image_key = String(form.get('logo_image_key') ?? '').trim() || null;
  const sort_order = parseInt(String(form.get('sort_order') ?? '0'), 10) || 0;

  const failPath = id ? `/companies/${id}` : '/companies/new';
  if (!name) return redirectWithToast(url, failPath, 'error', 'Company name is required.');

  const brand_color = brandRaw && /^#[0-9a-fA-F]{6}$/.test(brandRaw) ? brandRaw : null;
  if (brandRaw && !brand_color) return redirectWithToast(url, failPath, 'error', 'Brand color must be a 6-digit hex like #127475.');

  if (id) {
    await env.DB.prepare(
      `UPDATE companies SET name = ?, logo_image_key = ?, brand_color = ?, sort_order = ?, updated_at = unixepoch()
        WHERE id = ?`
    ).bind(name, logo_image_key, brand_color, sort_order, id).run();
    return redirectWithToast(url, `/companies/${id}`, 'success', 'Saved.');
  }

  const slugInput = String(form.get('slug') ?? '').trim();
  const slug = companySlug(slugInput || name);
  if (!slug) return redirectWithToast(url, failPath, 'error', 'Could not derive a slug. Enter one manually.');

  const existing = await getCompany(env, slug);
  if (existing) return redirectWithToast(url, failPath, 'error', `Slug "${slug}" is already taken.`);

  await env.DB.prepare(
    `INSERT INTO companies (id, name, logo_image_key, brand_color, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())`
  ).bind(slug, name, logo_image_key, brand_color, sort_order).run();
  return redirectWithToast(url, `/companies/${slug}`, 'success', 'Company created.');
}

async function deleteCompany(env: Env, id: string): Promise<Response> {
  // Unlink case studies first so they fall back to name matching rather than
  // pointing at a missing company id.
  await env.DB.prepare(`UPDATE case_studies SET company_id = NULL WHERE company_id = ?`).bind(id).run();
  await env.DB.prepare(`DELETE FROM companies WHERE id = ?`).bind(id).run();
  return new Response(null, { status: 303, headers: { Location: '/companies?toast=Company%20deleted&kind=success' } });
}

// ─── applications (job tracker) ──────────────────────────────────────────

interface ApplicationRow {
  id: string;
  company: string;
  role: string;
  location: string | null;
  jd_url: string | null;
  source: string | null;
  status: string;
  fit_score: number | null;
  fit_notes: string | null;
  notes: string | null;
  salary: string | null;
  resume_pdf_key: string | null;
  resume_docx_key: string | null;
  cover_pdf_key: string | null;
  cover_docx_key: string | null;
  applied_at: number | null;
  created_at: number;
  updated_at: number;
}

const APP_STATUSES: { value: string; label: string; color: string }[] = [
  { value: 'in_progress',  label: 'In Progress',  color: '#F7B32B' },
  { value: 'applied',      label: 'Applied',      color: '#127475' },
  { value: 'followed_up',  label: 'Followed Up',  color: '#5BA3A4' },
  { value: 'interviewing', label: 'Interviewing', color: '#8EECB1' },
  { value: 'offer',        label: 'Offer',        color: '#E2403E' },
  { value: 'denied',       label: 'Denied',       color: '#6A7678' },
];

function appStatusMeta(value: string): { value: string; label: string; color: string } {
  return APP_STATUSES.find((s) => s.value === value) ?? { value, label: value, color: '#8B9698' };
}

function appStatusBadge(value: string): string {
  const m = appStatusMeta(value);
  return `<span style="display:inline-block;padding:0.15rem 0.55rem;border-radius:999px;font-size:0.7rem;font-weight:600;color:${m.color};border:1px solid ${m.color}55;background:${m.color}1a;">${htmlEscape(m.label)}</span>`;
}

function appSlug(company: string, role: string): string {
  return `${company}-${role}`.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function epochToDateInput(epoch: number | null): string {
  if (!epoch) return '';
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

function dateInputToEpoch(s: string): number | null {
  if (!s) return null;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function fmtDate(epoch: number | null): string {
  if (!epoch) return '—';
  return new Date(epoch * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

const APPLICATION_COLUMNS =
  `id, company, role, location, jd_url, source, status, fit_score, fit_notes, notes, salary,
   resume_pdf_key, resume_docx_key, cover_pdf_key, cover_docx_key, applied_at, created_at, updated_at`;

async function listApplications(env: Env): Promise<ApplicationRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${APPLICATION_COLUMNS} FROM applications
      ORDER BY (status = 'denied') ASC, updated_at DESC`
  ).all<ApplicationRow>();
  return results ?? [];
}

async function getApplication(env: Env, id: string): Promise<ApplicationRow | null> {
  return await env.DB.prepare(
    `SELECT ${APPLICATION_COLUMNS} FROM applications WHERE id = ?`
  ).bind(id).first<ApplicationRow>();
}

async function listApplicationsPage(env: Env, url: URL): Promise<Response> {
  const rows = await listApplications(env);
  const counts = APP_STATUSES.map((s) => `${rows.filter((r) => r.status === s.value).length} ${s.label.toLowerCase()}`);
  const body = `
    <div class="toolbar">
      <h2 style="flex: 1;">Applications</h2>
      <a href="/applications/new" class="btn">+ New</a>
    </div>
    <p class="sub">Your job-search tracker. ${rows.length} total — ${counts.join(', ')}.</p>

    <table class="list">
      <thead>
        <tr>
          <th>Company / Role</th>
          <th>Status</th>
          <th>Docs</th>
          <th>Applied</th>
          <th>Updated</th>
          <th style="text-align: right;">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows.length === 0
          ? `<tr><td colspan="6" class="small" style="padding: 1.5rem; text-align: center; color: #7E8F91;">No applications yet. <a href="/applications/new">Add one</a>.</td></tr>`
          : rows.map((r) => {
          const docs = [
            r.resume_pdf_key || r.resume_docx_key ? 'Resume' : null,
            r.cover_pdf_key || r.cover_docx_key ? 'Cover' : null,
          ].filter(Boolean).join(' + ') || '<span style="color:#6A7678;">—</span>';
          const jd = r.jd_url
            ? ` &middot; <a href="${attrEscape(r.jd_url)}" target="_blank" rel="noopener" class="small">JD ↗</a>`
            : '';
          return `<tr>
            <td>
              <a href="/applications/${attrEscape(r.id)}" style="font-weight: 600; color: #E6EBE8;">${htmlEscape(r.company)}</a>
              <div class="small" style="color:#8B9698;">${htmlEscape(r.role)}${jd}</div>
            </td>
            <td>${appStatusBadge(r.status)}</td>
            <td class="small">${docs}</td>
            <td class="small">${fmtDate(r.applied_at)}</td>
            <td class="small" style="color:#8B9698;">${fmtDate(r.updated_at)}</td>
            <td style="text-align: right;"><a href="/applications/${attrEscape(r.id)}" class="btn secondary">Edit</a></td>
          </tr>`;
        }).join('\n')}
      </tbody>
    </table>
  `;
  return new Response(shell({ title: 'Applications', activeNav: 'applications', body, toast: readToast(url) }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

// One resume/cover document slot in the editor: shows current file (if any),
// an upload button, and a hidden key field. All four share one upload script.
function appDocSlot(slotId: string, label: string, fieldName: string, key: string | null): string {
  const view = key
    ? `<a href="/app-docs/${attrEscape(key)}" target="_blank" rel="noopener" class="small" id="${slotId}View">view current ↗</a>`
    : `<span class="small" id="${slotId}View" style="color:#6A7678;">none</span>`;
  return `
    <div class="field">
      <label>${htmlEscape(label)}</label>
      <div style="display:flex; gap:0.75rem; align-items:center; flex-wrap:wrap;">
        <input type="file" id="${slotId}File" accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.pdf,.docx" style="display:none;">
        <button type="button" class="btn secondary" id="${slotId}Btn">Upload</button>
        ${view}
        <button type="button" class="btn secondary" id="${slotId}Clear" style="color:#ff8585;border-color:#5a2a2a;${key ? '' : 'display:none;'}">Remove</button>
        <span id="${slotId}Status" class="hint"></span>
      </div>
      <input type="hidden" id="${slotId}Key" name="${fieldName}" value="${attrEscape(key ?? '')}">
    </div>`;
}

async function editApplicationPage(env: Env, id: string | null, url: URL): Promise<Response> {
  const row = id ? await getApplication(env, id) : null;
  if (id && !row) return new Response('Not found', { status: 404 });
  const isNew = !row;

  const statusOptions = APP_STATUSES.map((s) =>
    `<option value="${s.value}"${(row?.status ?? 'in_progress') === s.value ? ' selected' : ''}>${htmlEscape(s.label)}</option>`
  ).join('');

  const body = `
    <div class="toolbar">
      <a href="/applications" class="small" style="color: #8B9698;">← All applications</a>
    </div>
    <h2>${isNew ? 'New application' : `${htmlEscape(row!.company)} — ${htmlEscape(row!.role)}`}</h2>
    <p class="sub">${isNew ? 'Log a new application. Company and role are required.' : `Editing <code>${htmlEscape(row!.id)}</code>.`}</p>

    <form method="POST" action="${isNew ? '/applications/new' : `/applications/${attrEscape(row!.id)}`}" class="form-grid">
      <div class="row2">
        <div class="field">
          <label for="company">Company</label>
          <input id="company" name="company" type="text" required value="${attrEscape(row?.company ?? '')}" placeholder="Weedmaps">
        </div>
        <div class="field">
          <label for="role">Role</label>
          <input id="role" name="role" type="text" required value="${attrEscape(row?.role ?? '')}" placeholder="Senior Product Designer">
        </div>
      </div>

      <div class="row2">
        <div class="field">
          <label for="status">Status</label>
          <select id="status" name="status">${statusOptions}</select>
        </div>
        <div class="field">
          <label for="applied_at">Applied date</label>
          <input id="applied_at" name="applied_at" type="date" value="${attrEscape(epochToDateInput(row?.applied_at ?? null))}">
          <div class="hint">Leave blank if not yet applied.</div>
        </div>
      </div>

      <div class="row2">
        <div class="field">
          <label for="location">Location</label>
          <input id="location" name="location" type="text" value="${attrEscape(row?.location ?? '')}" placeholder="Remote / Irvine, CA">
        </div>
        <div class="field">
          <label for="source">Source</label>
          <input id="source" name="source" type="text" value="${attrEscape(row?.source ?? '')}" placeholder="LinkedIn, referral, ...">
        </div>
      </div>

      <div class="row2">
        <div class="field">
          <label for="jd_url">Job posting URL</label>
          <input id="jd_url" name="jd_url" type="url" value="${attrEscape(row?.jd_url ?? '')}" placeholder="https://...">
        </div>
        <div class="field">
          <label for="salary">Compensation</label>
          <input id="salary" name="salary" type="text" value="${attrEscape(row?.salary ?? '')}" placeholder="$160k–$190k">
        </div>
      </div>

      <div class="field">
        <label for="fit_score">Fit score (0–100, optional)</label>
        <input id="fit_score" name="fit_score" type="number" min="0" max="100" value="${row?.fit_score ?? ''}" style="max-width:8rem;">
      </div>

      <div class="field">
        <label for="fit_notes">Fit analysis</label>
        <textarea id="fit_notes" name="fit_notes" rows="5" placeholder="Why this role is a match; gaps to address.">${htmlEscape(row?.fit_notes ?? '')}</textarea>
      </div>

      <div class="field">
        <label for="notes">Notes / next steps</label>
        <textarea id="notes" name="notes" rows="4" placeholder="Recruiter name, interview dates, follow-up reminders.">${htmlEscape(row?.notes ?? '')}</textarea>
      </div>

      <fieldset style="border:1px solid #1B3A3F;border-radius:8px;padding:1rem 1.25rem;margin:0;">
        <legend class="small" style="color:#7E8F91;text-transform:uppercase;letter-spacing:0.08em;padding:0 0.4rem;">Documents (private)</legend>
        <p class="hint" style="margin-top:0;">Stored in the private bucket and only downloadable while signed in. PDF or DOCX.</p>
        <div class="row2">
          ${appDocSlot('resumePdf',  'Resume (PDF)',        'resume_pdf_key',  row?.resume_pdf_key ?? null)}
          ${appDocSlot('resumeDocx', 'Resume (DOCX)',       'resume_docx_key', row?.resume_docx_key ?? null)}
        </div>
        <div class="row2">
          ${appDocSlot('coverPdf',   'Cover letter (PDF)',  'cover_pdf_key',   row?.cover_pdf_key ?? null)}
          ${appDocSlot('coverDocx',  'Cover letter (DOCX)', 'cover_docx_key',  row?.cover_docx_key ?? null)}
        </div>
      </fieldset>

      <div style="display: flex; gap: 0.75rem; align-items: center;">
        <button type="submit" class="btn">${isNew ? 'Create' : 'Save changes'}</button>
        <a href="/applications" class="btn secondary">Cancel</a>
        ${isNew ? '' : `<button type="submit" formaction="/applications/${attrEscape(row!.id)}/delete" formmethod="POST" class="btn secondary" style="margin-left:auto;color:#ff8585;border-color:#5a2a2a;" onclick="return confirm('Delete this application and its uploaded documents? This cannot be undone.');">Delete</button>`}
      </div>
    </form>

    <script>
      (function(){
        var slots = ['resumePdf','resumeDocx','coverPdf','coverDocx'];
        slots.forEach(function(s){
          var btn = document.getElementById(s + 'Btn');
          var input = document.getElementById(s + 'File');
          var status = document.getElementById(s + 'Status');
          var keyField = document.getElementById(s + 'Key');
          var view = document.getElementById(s + 'View');
          var clear = document.getElementById(s + 'Clear');
          if (!btn) return;
          btn.addEventListener('click', function(){ input.click(); });
          clear.addEventListener('click', function(){
            keyField.value = '';
            if (view) { view.outerHTML = '<span class="small" id="' + s + 'View" style="color:#6A7678;">none</span>'; }
            clear.style.display = 'none';
            status.textContent = 'Cleared. Save to apply.';
          });
          input.addEventListener('change', async function(){
            var f = input.files && input.files[0];
            if (!f) return;
            status.textContent = 'Uploading ' + f.name + '…';
            try {
              var fd = new FormData();
              fd.append('file', f);
              var r = await fetch('/api/app-docs', { method: 'POST', body: fd, credentials: 'same-origin' });
              if (!r.ok) { var j = await r.json().catch(function(){return {};}); throw new Error(j.error || ('upload failed: ' + r.status)); }
              var j = await r.json();
              keyField.value = j.key;
              var link = document.getElementById(s + 'View');
              var html = '<a href="/app-docs/' + encodeURIComponent(j.key) + '" target="_blank" rel="noopener" class="small" id="' + s + 'View">view current ↗</a>';
              if (link) { link.outerHTML = html; }
              clear.style.display = '';
              status.textContent = 'Uploaded. Save to apply.';
            } catch (ex) {
              status.textContent = 'Upload failed: ' + (ex.message || ex);
            } finally { input.value = ''; }
          });
        });
      })();
    </script>
  `;
  return new Response(shell({ title: isNew ? 'New application' : `Edit ${row!.company}`, activeNav: 'applications', body, toast: readToast(url) }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

async function saveApplication(request: Request, env: Env, id: string | null): Promise<Response> {
  const url = new URL(request.url);
  const form = await request.formData();
  const company = String(form.get('company') ?? '').trim();
  const role = String(form.get('role') ?? '').trim();
  const failPath = id ? `/applications/${id}` : '/applications/new';
  if (!company) return redirectWithToast(url, failPath, 'error', 'Company is required.');
  if (!role)    return redirectWithToast(url, failPath, 'error', 'Role is required.');

  const status = String(form.get('status') ?? 'in_progress').trim();
  const validStatus = APP_STATUSES.some((s) => s.value === status) ? status : 'in_progress';
  const str = (k: string) => { const v = String(form.get(k) ?? '').trim(); return v || null; };
  const location = str('location');
  const jd_url = str('jd_url');
  const source = str('source');
  const salary = str('salary');
  const fit_notes = str('fit_notes');
  const notes = str('notes');
  const fitRaw = String(form.get('fit_score') ?? '').trim();
  const fit_score = fitRaw === '' ? null : Math.max(0, Math.min(100, parseInt(fitRaw, 10) || 0));
  let applied_at = dateInputToEpoch(String(form.get('applied_at') ?? '').trim());
  // If marked applied (or further) but no date given, stamp today.
  if (!applied_at && validStatus !== 'in_progress') applied_at = nowSeconds();
  const resume_pdf_key  = str('resume_pdf_key');
  const resume_docx_key = str('resume_docx_key');
  const cover_pdf_key   = str('cover_pdf_key');
  const cover_docx_key  = str('cover_docx_key');

  if (id) {
    // Clean up any private docs that were removed in this edit.
    const prev = await getApplication(env, id);
    if (prev) {
      const pairs: [string | null, string | null][] = [
        [prev.resume_pdf_key, resume_pdf_key],
        [prev.resume_docx_key, resume_docx_key],
        [prev.cover_pdf_key, cover_pdf_key],
        [prev.cover_docx_key, cover_docx_key],
      ];
      for (const [oldKey, newKey] of pairs) {
        if (oldKey && oldKey !== newKey) await deleteDoc(env, oldKey);
      }
    }
    await env.DB.prepare(
      `UPDATE applications SET
         company = ?, role = ?, location = ?, jd_url = ?, source = ?, status = ?,
         fit_score = ?, fit_notes = ?, notes = ?, salary = ?,
         resume_pdf_key = ?, resume_docx_key = ?, cover_pdf_key = ?, cover_docx_key = ?,
         applied_at = ?, updated_at = unixepoch()
       WHERE id = ?`
    ).bind(company, role, location, jd_url, source, validStatus,
           fit_score, fit_notes, notes, salary,
           resume_pdf_key, resume_docx_key, cover_pdf_key, cover_docx_key,
           applied_at, id).run();
    return redirectWithToast(url, `/applications/${id}`, 'success', 'Saved.');
  }

  // New: derive a unique slug.
  let slug = appSlug(company, role);
  if (!slug) return redirectWithToast(url, failPath, 'error', 'Could not derive an id from company/role.');
  if (await getApplication(env, slug)) slug = `${slug}-${randomToken(2)}`;

  await env.DB.prepare(
    `INSERT INTO applications
       (id, company, role, location, jd_url, source, status, fit_score, fit_notes, notes, salary,
        resume_pdf_key, resume_docx_key, cover_pdf_key, cover_docx_key, applied_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())`
  ).bind(slug, company, role, location, jd_url, source, validStatus, fit_score, fit_notes, notes, salary,
         resume_pdf_key, resume_docx_key, cover_pdf_key, cover_docx_key, applied_at).run();
  return redirectWithToast(url, `/applications/${slug}`, 'success', 'Application created.');
}

async function deleteApplication(env: Env, id: string): Promise<Response> {
  const row = await getApplication(env, id);
  if (row) {
    for (const k of [row.resume_pdf_key, row.resume_docx_key, row.cover_pdf_key, row.cover_docx_key]) {
      if (k) await deleteDoc(env, k);
    }
  }
  await env.DB.prepare(`DELETE FROM applications WHERE id = ?`).bind(id).run();
  return new Response(null, { status: 303, headers: { Location: '/applications?toast=Application%20deleted&kind=success' } });
}

// ─── private documents (resume / cover letter) ───────────────────────────

// Upload an application document to PRIVATE_BUCKET. Returns { key }.
async function handleDocUpload(request: Request, env: Env): Promise<Response> {
  const ct = request.headers.get('Content-Type') ?? '';
  if (!ct.startsWith('multipart/form-data')) {
    return Response.json({ error: 'multipart/form-data required' }, { status: 400 });
  }
  const form = await request.formData();
  const fileEntry = form.get('file');
  if (!fileEntry || typeof fileEntry === 'string' || typeof (fileEntry as any).stream !== 'function') {
    return Response.json({ error: 'file field missing' }, { status: 400 });
  }
  const file = fileEntry as unknown as { name: string; type: string; size: number; stream(): ReadableStream };
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` }, { status: 413 });
  }
  if (!ALLOWED_DOC_MIME.has(file.type)) {
    return Response.json({ error: `Unsupported type: ${file.type || 'unknown'}. Use PDF or DOCX.` }, { status: 415 });
  }
  const ext = (file.name.match(/\.[A-Za-z0-9]+$/)?.[0] || '').toLowerCase();
  const safeBase = file.name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60);
  const key = `apps/${nowSeconds()}-${randomToken(4)}-${safeBase}${safeBase.toLowerCase().endsWith(ext) ? '' : ext}`;
  await env.PRIVATE_BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type, contentDisposition: `inline; filename="${safeBase}"` },
  });
  return Response.json({ ok: true, key });
}

async function deleteDoc(env: Env, key: string): Promise<void> {
  try { await env.PRIVATE_BUCKET.delete(key); } catch { /* best effort */ }
}

// Stream a private document. Only reachable behind requireSession, and scoped to
// the apps/ prefix so this can never serve arbitrary private objects.
async function serveAppDoc(env: Env, key: string): Promise<Response> {
  if (!key.startsWith('apps/')) return new Response('Forbidden', { status: 403 });
  const obj = await env.PRIVATE_BUCKET.get(key);
  if (!obj) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/octet-stream');
  return new Response(obj.body, { headers });
}

// ─── pages: site content ─────────────────────────────────────────────────

const CONTENT_KEY_LABELS: Record<string, { label: string; help: string }> = {
  ticker_label: { label: 'Ticker label', help: 'Static text before the rotating ticker, e.g. "I design".' },
  ticker_phrases: { label: 'Ticker phrases (JSON array)', help: 'Rotating phrases. JSON array of strings.' },
  hero_role: { label: 'Hero role', help: 'The role line above your name in the homepage hero, e.g. "Senior Product Designer".' },
  hero_tagline: { label: 'Hero tagline', help: 'The intro paragraph under your name in the homepage hero.' },
  footer_email: { label: 'Footer email', help: 'Email shown in the footer (and used for mailto: links).' },
  footer_linkedin: { label: 'Footer LinkedIn URL', help: 'LinkedIn profile URL.' },
  building_eyebrow: { label: 'Now building — eyebrow', help: 'Small label above the heading in the homepage "Now building" section, e.g. "Now building".' },
  building_heading: { label: 'Now building — heading', help: 'The heading for the homepage "Now building" section, e.g. "On my own terms.".' },
  building_intro: { label: 'Now building — intro', help: 'The intro paragraph beside the heading in the "Now building" section.' },
};

function describeContentKey(key: string): { label: string; help: string } {
  return CONTENT_KEY_LABELS[key] ?? { label: key, help: '' };
}

async function listContentPage(env: Env, url: URL): Promise<Response> {
  const rows = await listContent(env);
  const body = `
    <h2>Site Content</h2>
    <p class="sub">Editable copy for the homepage. JSON keys hold structured data, edit as JSON.</p>

    <table class="list">
      <thead>
        <tr>
          <th>Key</th>
          <th>Type</th>
          <th>Preview</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => {
          const { label } = describeContentKey(r.key);
          const preview = r.value_type === 'json'
            ? r.value.slice(0, 120) + (r.value.length > 120 ? '…' : '')
            : r.value.replace(/<[^>]+>/g, '').slice(0, 120) + (r.value.length > 120 ? '…' : '');
          return `<tr>
            <td>
              <a href="/content/${attrEscape(r.key)}" style="font-weight: 600; color: #E6EBE8;">${htmlEscape(label)}</a>
              <div class="small">${htmlEscape(r.key)}</div>
            </td>
            <td><span class="badge hidden">${htmlEscape(r.value_type)}</span></td>
            <td class="small" style="max-width: 460px;">${htmlEscape(preview)}</td>
            <td style="text-align: right;"><a href="/content/${attrEscape(r.key)}" class="btn secondary">Edit</a></td>
          </tr>`;
        }).join('\n')}
      </tbody>
    </table>
  `;
  return new Response(shell({ title: 'Site Content', activeNav: 'content', body, toast: readToast(url) }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

async function editContentPage(env: Env, key: string, url: URL): Promise<Response> {
  const row = await getContent(env, key);
  if (!row) return new Response('Not found', { status: 404 });
  const { label, help } = describeContentKey(row.key);

  let displayValue = row.value;
  if (row.value_type === 'json') {
    try { displayValue = JSON.stringify(JSON.parse(row.value), null, 2); } catch { /* keep raw */ }
  }

  const isLong = row.value.length > 200 || row.value_type === 'json' || row.value_type === 'html' || row.value_type === 'markdown';
  const rows = Math.min(28, Math.max(8, displayValue.split('\n').length + 2));

  const body = `
    <div class="toolbar">
      <a href="/content" class="small" style="color: #8B9698;">← All site content</a>
    </div>
    <h2>${htmlEscape(label)}</h2>
    <p class="sub">${htmlEscape(help)}</p>

    <form method="POST" action="/content/${attrEscape(row.key)}" class="form-grid">
      <div class="row2">
        <div class="field">
          <label>Key</label>
          <input type="text" value="${attrEscape(row.key)}" readonly>
        </div>
        <div class="field">
          <label for="value_type">Type</label>
          <select id="value_type" name="value_type">
            <option value="text"     ${row.value_type === 'text'     ? 'selected' : ''}>text</option>
            <option value="markdown" ${row.value_type === 'markdown' ? 'selected' : ''}>markdown</option>
            <option value="html"     ${row.value_type === 'html'     ? 'selected' : ''}>html</option>
            <option value="json"     ${row.value_type === 'json'     ? 'selected' : ''}>json</option>
          </select>
        </div>
      </div>

      <div class="field">
        <label for="value">Value</label>
        ${isLong
          ? `<textarea id="value" name="value" rows="${rows}">${htmlEscape(displayValue)}</textarea>`
          : `<input id="value" name="value" type="text" value="${attrEscape(displayValue)}">`}
      </div>

      <div style="display: flex; gap: 0.75rem;">
        <button type="submit" class="btn">Save</button>
        <a href="/content" class="btn secondary">Cancel</a>
      </div>
    </form>
  `;
  return new Response(shell({ title: `Edit ${label}`, activeNav: 'content', body, toast: readToast(url) }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

async function saveContent(request: Request, env: Env, key: string): Promise<Response> {
  const url = new URL(request.url);
  const form = await request.formData();
  const value = String(form.get('value') ?? '');
  const value_type = String(form.get('value_type') ?? 'text');

  if (value_type === 'json') {
    try { JSON.parse(value); } catch (e: any) {
      return redirectWithToast(url, `/content/${key}`, 'error', `JSON invalid: ${e.message ?? e}`);
    }
  }

  await env.DB.prepare(
    `INSERT INTO site_content (key, value, value_type, updated_at) VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, value_type = excluded.value_type, updated_at = excluded.updated_at`
  ).bind(key, value, value_type).run();

  return redirectWithToast(url, `/content/${key}`, 'success', 'Saved.');
}

// ─── uploads ─────────────────────────────────────────────────────────────

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const ct = request.headers.get('Content-Type') ?? '';
  if (!ct.startsWith('multipart/form-data')) {
    return Response.json({ error: 'multipart/form-data required' }, { status: 400 });
  }
  const form = await request.formData();
  const fileEntry = form.get('file');
  // form.get returns string | File in spec; duck-typing keeps Workers TS happy.
  if (!fileEntry || typeof fileEntry === 'string' || typeof (fileEntry as any).stream !== 'function') {
    return Response.json({ error: 'file field missing' }, { status: 400 });
  }
  const file = fileEntry as unknown as { name: string; type: string; size: number; stream(): ReadableStream };
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` }, { status: 413 });
  }
  if (!ALLOWED_UPLOAD_MIME.has(file.type)) {
    return Response.json({ error: `Unsupported type: ${file.type}` }, { status: 415 });
  }

  const ext = (file.name.match(/\.[A-Za-z0-9]+$/)?.[0] || '').toLowerCase();
  const safeBase = file.name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60);
  const key = `${nowSeconds()}-${randomToken(4)}-${safeBase}${safeBase.toLowerCase().endsWith(ext) ? '' : ext}`;

  await env.PUBLIC_BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
  });

  return Response.json({ ok: true, key, url: `/uploads/${key}` });
}

// ─── login + health ──────────────────────────────────────────────────────

function loginPage(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Admin · Barbara Broadnax</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;background:#0D1B1E;color:#E6EBE8;min-height:100vh;display:grid;place-items:center;margin:0;}
  form{background:#122A2E;padding:2rem;border-radius:8px;min-width:320px;box-shadow:0 10px 40px rgba(0,0,0,0.4);}
  h1{margin:0 0 .25rem;font-weight:500;font-size:1.15rem;color:#E2403E;letter-spacing:0.04em;}
  p.sub{margin:0 0 1.5rem;color:#7E8F91;font-size:.85rem;}
  label{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:#7E8F91;display:block;margin-bottom:.5rem;}
  input{width:100%;padding:.75rem;border-radius:4px;border:1px solid #244549;background:#0D1B1E;color:#E6EBE8;box-sizing:border-box;font-family:inherit;font-size:1rem;}
  input:focus{outline:none;border-color:#E2403E;}
  button{width:100%;margin-top:1rem;padding:.75rem;border:0;border-radius:4px;background:#E2403E;color:#0D1B1E;font-weight:600;cursor:pointer;font-size:.95rem;}
  button:disabled{opacity:.5;cursor:not-allowed;}
  .err{color:#ff6b6b;margin-top:.75rem;font-size:.85rem;min-height:1em;}
</style>
</head>
<body>
<form id="f">
  <h1>broadnaxux admin</h1>
  <p class="sub">Sign in to manage your portfolio.</p>
  <label for="pw">Password</label>
  <input id="pw" type="password" name="password" autofocus required>
  <button type="submit">Sign in</button>
  <div class="err" id="err"></div>
</form>
<script>
  const f = document.getElementById('f');
  const err = document.getElementById('err');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const btn = f.querySelector('button');
    btn.disabled = true;
    try {
      const password = new FormData(f).get('password');
      const r = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }), credentials: 'same-origin',
      });
      if (r.ok) { location.href = '/dashboard'; }
      else { const j = await r.json().catch(() => ({})); err.textContent = j.error || 'Sign-in failed'; }
    } catch (ex) { err.textContent = 'Network error'; }
    finally { btn.disabled = false; }
  });
</script>
</body>
</html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

async function handleHealth(env: Env): Promise<Response> {
  try {
    const row = await env.DB.prepare('SELECT key FROM site_content LIMIT 1').first<{ key: string }>();
    const slMigrationApplied = await safeFirst<{ n: number }>(env, 'SELECT count(*) as n FROM share_links');
    return Response.json({
      ok: true,
      db: row ? 'connected-with-data' : 'connected-empty',
      worker: 'broadnaxux-admin',
      password_configured: Boolean(env.ADMIN_PASSWORD_HASH),
      share_links_migration: slMigrationApplied !== null ? 'applied' : 'pending',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

// ─── share-links: helpers ────────────────────────────────────────────────

const MAX_PDF_BYTES = 8 * 1024 * 1024;
const PDF_MIME_TYPES = new Set(['application/pdf']);

interface ShareLinkRow {
  id: string;
  token: string;
  name: string;
  recipient_label: string | null;
  case_study_ids: string;
  resume_file_key: string | null;
  resume_file_name: string | null;
  custom_headline: string | null;
  custom_message: string | null;
  password_hash: string | null;
  created_at: number;
  expires_at: number | null;
  last_viewed_at: number | null;
  slug: string | null;
  case_study_versions: string | null;  // JSON object { csId: versionId }
}

// Allowed: lowercase a-z, 0-9, hyphen. 3-40 chars. Must start/end alphanumeric.
// Reserved values are rejected at save time (see RESERVED_SLUGS).
const SHORT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const RESERVED_SLUGS = new Set(['new', 'edit', 'delete', 'admin', 'api']);

interface ShareLinkListRow extends ShareLinkRow {
  view_count: number;
}

async function safeFirst<T>(env: Env, sql: string): Promise<T | null> {
  try { return await env.DB.prepare(sql).first<T>(); } catch { return null; }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hashPassword(password: string, iterations = 100000): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      keyMaterial, 256
    )
  );
  return `${bytesToBase64(salt)}:${iterations}:${bytesToBase64(derived)}`;
}

function newShareLinkId(): string {
  // 18 bytes → 24-char base64url (url-safe, no padding)
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(18)));
}

function newShareToken(): string {
  // 16 bytes → ~22 chars base64url. Plenty of entropy, not too long for emails.
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

async function listShareLinks(env: Env): Promise<ShareLinkListRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT sl.id, sl.token, sl.name, sl.recipient_label, sl.case_study_ids,
            sl.resume_file_key, sl.resume_file_name, sl.custom_headline, sl.custom_message,
            sl.password_hash, sl.created_at, sl.expires_at, sl.last_viewed_at, sl.slug,
            sl.case_study_versions,
            COALESCE((SELECT COUNT(*) FROM share_link_views v
                       WHERE v.share_link_id = sl.id AND v.event = 'open'), 0) as view_count
       FROM share_links sl
   ORDER BY sl.created_at DESC`
  ).all<ShareLinkListRow>();
  return results ?? [];
}

async function getShareLink(env: Env, id: string): Promise<ShareLinkRow | null> {
  return env.DB.prepare(
    `SELECT id, token, name, recipient_label, case_study_ids, resume_file_key,
            resume_file_name, custom_headline, custom_message, password_hash,
            created_at, expires_at, last_viewed_at, slug, case_study_versions
       FROM share_links WHERE id = ?`
  ).bind(id).first<ShareLinkRow>();
}

interface PickerCaseStudy {
  id: string;
  title: string;
  company: string;
  status: string;
}

async function listPickerCaseStudies(env: Env): Promise<PickerCaseStudy[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, company, status FROM case_studies
   ORDER BY status = 'published' DESC, sort_order ASC, created_at ASC`
  ).all<PickerCaseStudy>();
  return results ?? [];
}

interface PickerVersion { id: string; case_study_id: string; label: string; }

async function listAllCaseStudyVersions(env: Env): Promise<PickerVersion[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, case_study_id, label FROM case_study_versions
       ORDER BY case_study_id, created_at DESC`
    ).all<PickerVersion>();
    return results ?? [];
  } catch {
    // Migration 0006 not applied yet — feature is gracefully off.
    return [];
  }
}

function publicShareUrl(token: string): string {
  return `https://barbarabroadnax.com/share/${token}`;
}

function publicShortUrl(slug: string): string {
  return `https://barbarabroadnax.com/r/${slug}`;
}

// Returns the URL we want to surface in the admin UI as the primary public
// link. /r/<slug> when slug is set (because that's what BB pastes into
// emails); otherwise the canonical /share/<token>.
function preferredPublicUrl(row: { token: string; slug: string | null }): string {
  return row.slug ? publicShortUrl(row.slug) : publicShareUrl(row.token);
}

async function isSlugTaken(env: Env, slug: string, excludeId: string | null): Promise<boolean> {
  const stmt = excludeId
    ? env.DB.prepare(`SELECT id FROM share_links WHERE slug = ? AND id != ? LIMIT 1`).bind(slug, excludeId)
    : env.DB.prepare(`SELECT id FROM share_links WHERE slug = ? LIMIT 1`).bind(slug);
  const row = await stmt.first();
  return row !== null;
}

function formatTimestamp(unix: number | null): string {
  if (!unix) return '—';
  const d = new Date(unix * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function expiryStatus(row: ShareLinkRow | ShareLinkListRow): { label: string; expired: boolean } {
  if (!row.expires_at) return { label: 'No expiry', expired: false };
  const now = nowSeconds();
  if (row.expires_at < now) return { label: `Expired ${formatTimestamp(row.expires_at)}`, expired: true };
  return { label: `Expires ${formatTimestamp(row.expires_at)}`, expired: false };
}

// ─── share-links: list page ──────────────────────────────────────────────

async function listShareLinksPage(env: Env, url: URL): Promise<Response> {
  let rows: ShareLinkListRow[] = [];
  try {
    rows = await listShareLinks(env);
  } catch (e: any) {
    const body = `
      <h2>Share Links</h2>
      <p class="sub">Schema not yet applied. Run migration 0003 to enable this feature.</p>
      <pre style="background:#122A2E;border:1px solid #1B3A3F;border-radius:6px;padding:1rem;color:#8eecb1;font-size:0.78rem;overflow:auto;">wrangler d1 execute broadnaxux-content --remote --file=cloudflare/migrations/0003_share_links.sql</pre>
      <p class="sub" style="margin-top:1rem;">Error: ${htmlEscape(String(e?.message ?? e))}</p>
    `;
    return new Response(shell({ title: 'Share Links', activeNav: 'share-links', body }), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' },
    });
  }

  const body = `
    <div class="toolbar">
      <h2 style="flex: 1;">Share Links</h2>
      <a href="/share-links/new" class="btn">+ New share-link</a>
    </div>
    <p class="sub">Curated, optionally password-protected views with view tracking. Use these for recruiters, hiring managers, and tailored outreach.</p>

    ${rows.length === 0 ? `
      <div style="background:#122A2E;border:1px solid #1B3A3F;border-radius:8px;padding:2.5rem;text-align:center;color:#8B9698;">
        No share-links yet. <a href="/share-links/new">Create the first one</a>.
      </div>
    ` : `
    <table class="list">
      <thead>
        <tr>
          <th>Name</th>
          <th>Recipient</th>
          <th style="width: 6rem; text-align:right;">Views</th>
          <th>Expiry</th>
          <th>Created</th>
          <th style="text-align: right;">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => shareLinkListRow(r)).join('\n')}
      </tbody>
    </table>
    `}
  `;
  return new Response(shell({ title: 'Share Links', activeNav: 'share-links', body, toast: readToast(url) }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

function shareLinkListRow(r: ShareLinkListRow): string {
  const exp = expiryStatus(r);
  const pwBadge = r.password_hash
    ? '<span class="badge published" style="background: rgba(226,64,62,0.12); color:#E2403E; border-color: rgba(226,64,62,0.3); margin-left:0.4rem;">password</span>'
    : '';
  const expiredBadge = exp.expired
    ? '<span class="badge hidden" style="margin-left:0.4rem;">expired</span>'
    : '';
  const nameSafeForJs = htmlEscape(r.name).replace(/'/g, "&#39;");
  const publicUrl = preferredPublicUrl(r);
  const displayPath = r.slug ? `/r/${r.slug}` : `/share/${r.token}`;
  return `        <tr>
          <td>
            <a href="/share-links/${attrEscape(r.id)}" style="font-weight: 600; color: #E6EBE8;">${htmlEscape(r.name)}</a>${pwBadge}${expiredBadge}
            <div class="small">
              <a href="${attrEscape(publicUrl)}" target="_blank" rel="noopener" style="color: #E2403E;">${htmlEscape(displayPath)}</a>
              <button type="button" class="btn secondary" data-copy="${attrEscape(publicUrl)}" style="margin-left:0.5rem;padding:0.1rem 0.4rem;font-size:0.65rem;">Copy URL</button>
            </div>
          </td>
          <td>${htmlEscape(r.recipient_label ?? '—')}</td>
          <td style="text-align:right; font-variant-numeric: tabular-nums;">${r.view_count}</td>
          <td class="small">${htmlEscape(exp.label)}</td>
          <td class="small">${htmlEscape(formatTimestamp(r.created_at))}</td>
          <td>
            <div class="actions">
              <a href="/share-links/${attrEscape(r.id)}/analytics" class="btn secondary" title="View analytics">Analytics</a>
              <a href="/share-links/${attrEscape(r.id)}" class="btn secondary">Edit</a>
              <form method="POST" action="/share-links/${attrEscape(r.id)}/delete" onsubmit="return confirm('Delete &quot;${nameSafeForJs}&quot;? The URL will stop working.');">
                <button class="btn danger">Delete</button>
              </form>
            </div>
          </td>
        </tr>`;
}

// ─── share-links: edit page ──────────────────────────────────────────────

async function editShareLinkPage(env: Env, id: string | null, url: URL): Promise<Response> {
  const isNew = id === null;
  let row: ShareLinkRow | null = null;
  try {
    row = isNew ? null : await getShareLink(env, id!);
  } catch (e: any) {
    return new Response(`Schema not applied yet: ${e?.message ?? e}`, { status: 500 });
  }
  if (!isNew && !row) return new Response('Not found', { status: 404 });

  let allCaseStudies: PickerCaseStudy[] = [];
  try { allCaseStudies = await listPickerCaseStudies(env); } catch { /* empty */ }

  // All versions across all case studies. Picker renders a dropdown per
  // selected case study only when versions exist for it.
  const allVersions = await listAllCaseStudyVersions(env);

  let selectedIds: string[] = [];
  try {
    const parsed = JSON.parse(row?.case_study_ids ?? '[]');
    if (Array.isArray(parsed)) selectedIds = parsed.filter((x: unknown) => typeof x === 'string');
  } catch { /* empty */ }

  // Existing case_study_versions map. Object: { csId: versionId }
  let selectedVersions: Record<string, string> = {};
  try {
    const parsed = JSON.parse(row?.case_study_versions ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') selectedVersions[k] = v;
      }
    }
  } catch { /* empty */ }

  const expiryDate = row?.expires_at ? formatTimestamp(row.expires_at) : '';
  const pickerJson = JSON.stringify(allCaseStudies);
  const selectedJson = JSON.stringify(selectedIds);
  const versionsJson = JSON.stringify(allVersions);
  const selectedVersionsJson = JSON.stringify(selectedVersions);

  const primaryUrl = isNew ? '' : preferredPublicUrl(row!);
  const fallbackBlock = !isNew && row!.slug
    ? `<div style="font-size:0.7rem;color:#7E8F91;margin-top:0.4rem;">also reachable as <code style="color:#7E8F91;">${htmlEscape(publicShareUrl(row!.token))}</code></div>`
    : '';
  const publicUrlBlock = isNew ? '' : `
    <div style="background:#122A2E;border:1px solid #1B3A3F;border-radius:6px;padding:1rem 1.1rem;margin-bottom:1.5rem;display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:0.6rem;text-transform:uppercase;letter-spacing:0.1em;color:#7E8F91;margin-bottom:0.25rem;">Public URL</div>
        <code style="color:#E2403E;font-size:0.85rem;word-break:break-all;">${htmlEscape(primaryUrl)}</code>${fallbackBlock}
      </div>
      <button type="button" class="btn secondary" data-copy="${attrEscape(primaryUrl)}">Copy</button>
      <a href="${attrEscape(primaryUrl)}" target="_blank" rel="noopener" class="btn secondary">Open ↗</a>
      <a href="/share-links/${attrEscape(row!.id)}/analytics" class="btn secondary">Analytics</a>
    </div>
  `;

  const resumeBlock = row?.resume_file_key ? `
    <div style="background:#0D1B1E;border:1px solid #244549;border-radius:4px;padding:0.55rem 0.8rem;margin-bottom:0.5rem;display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;">
      <span>Current resume: <strong>${htmlEscape(row.resume_file_name ?? row.resume_file_key)}</strong></span>
      <label style="margin-left:auto;color:#ff6b6b;font-size:0.78rem;cursor:pointer;">
        <input type="checkbox" name="remove_resume" value="1" style="vertical-align:middle;margin-right:0.3rem;">
        remove on save
      </label>
    </div>
  ` : '';

  const body = `
    <div class="toolbar">
      <a href="/share-links" class="small" style="color: #8B9698;">← All share-links</a>
    </div>
    <h2>${isNew ? 'New share-link' : htmlEscape(row!.name)}</h2>
    <p class="sub">${isNew ? 'Curated case study list with optional headline, message, password, and resume PDF.' : `Created ${htmlEscape(formatTimestamp(row!.created_at))}. ${row!.last_viewed_at ? 'Last viewed ' + htmlEscape(formatTimestamp(row!.last_viewed_at)) + '.' : 'Not yet opened.'}`}</p>

    ${publicUrlBlock}

    <form method="POST" action="${isNew ? '/share-links/new' : '/share-links/' + attrEscape(row!.id)}" enctype="multipart/form-data" id="slForm" class="form-grid">
      <div class="row2">
        <div class="field">
          <label for="name">Internal name *</label>
          <input id="name" name="name" type="text" required value="${attrEscape(row?.name ?? '')}" placeholder="e.g. Stripe – Sr Product Designer (Apr 2026)">
          <div class="hint">Admin-only label. Helps you find this share-link later.</div>
        </div>
        <div class="field">
          <label for="recipient_label">Recipient (admin-only)</label>
          <input id="recipient_label" name="recipient_label" type="text" value="${attrEscape(row?.recipient_label ?? '')}" placeholder="e.g. Jane Smith, Stripe">
          <div class="hint">Never shown to the recipient. Just for your own tracking.</div>
        </div>
      </div>

      <div class="field">
        <label for="slug">Short URL (optional)</label>
        <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
          <span style="color:#7E8F91;font-size:0.85rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;">barbarabroadnax.com/r/</span>
          <input id="slug" name="slug" type="text" pattern="[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?" maxlength="40" value="${attrEscape(row?.slug ?? '')}" placeholder="e.g. jane-stripe" style="flex:1;min-width:14rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">
        </div>
        <div class="hint">Lowercase letters, digits, hyphens. 3-40 characters, must start and end alphanumeric. Must be unique across share-links. Leave blank to use the canonical /share/&lt;token&gt; URL.</div>
      </div>

      <div class="field">
        <label>Case studies — pick + reorder</label>
        <div class="hint" style="margin-bottom:0.5rem;">Check to include. Drag, or use ↑↓ on the right list, to set the order recipients see. Only published case studies are linkable on the public site.</div>
        <div style="display:grid;grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div style="background:#0D1B1E;border:1px solid #244549;border-radius:4px;padding:0.5rem;">
            <div style="font-size:0.6rem;text-transform:uppercase;letter-spacing:0.1em;color:#7E8F91;padding:0.3rem 0.5rem 0.5rem;">Available</div>
            <div id="slAvailable"></div>
          </div>
          <div style="background:#0D1B1E;border:1px solid #244549;border-radius:4px;padding:0.5rem;">
            <div style="font-size:0.6rem;text-transform:uppercase;letter-spacing:0.1em;color:#7E8F91;padding:0.3rem 0.5rem 0.5rem;">In this share-link <span id="slCountBadge" style="color:#E2403E;"></span></div>
            <div id="slSelected"></div>
          </div>
        </div>
        <input type="hidden" name="case_study_ids" id="case_study_ids" value="${attrEscape(JSON.stringify(selectedIds))}">
        <input type="hidden" name="case_study_versions" id="case_study_versions" value="${attrEscape(JSON.stringify(selectedVersions))}">
      </div>

      <div class="field">
        <label for="custom_headline">Custom headline</label>
        <input id="custom_headline" name="custom_headline" type="text" maxlength="160" value="${attrEscape(row?.custom_headline ?? '')}" placeholder="e.g. Selected work for Stripe">
        <div class="hint">Shown at the top of the share-link page in place of the default. Optional.</div>
      </div>

      <div class="field">
        <label for="custom_message">Custom message (HTML allowed)</label>
        <textarea id="custom_message" name="custom_message" rows="5" placeholder="Optional note above the case study list. Plain prose or inline HTML.">${htmlEscape(row?.custom_message ?? '')}</textarea>
        <div class="hint">Shown above the case study list. Inline HTML (e.g. &lt;strong&gt;) is rendered as-is.</div>
      </div>

      <div class="row2">
        <div class="field">
          <label for="expires_at">Expiry date</label>
          <input id="expires_at" name="expires_at" type="date" value="${attrEscape(expiryDate)}">
          <div class="hint">Leave blank for no expiry. Expired links show a "this link has expired" page.</div>
        </div>
        <div class="field">
          <label for="password">Password ${row?.password_hash ? '(set, leave blank to keep)' : '(optional)'}</label>
          <input id="password" name="password" type="text" value="" placeholder="${row?.password_hash ? '••••••• (leave blank to keep current)' : 'leave blank for no password'}">
          <div class="hint">Type any string. Recipients enter this to unlock the page. To remove an existing password, type "remove".</div>
        </div>
      </div>

      <div class="field">
        <label>Custom resume PDF (optional)</label>
        ${resumeBlock}
        <input type="file" id="resume" name="resume" accept="application/pdf">
        <div class="hint">PDF only, max 8 MB. Served via signed-URL flow from the private R2 bucket. Replaces any existing file on save.</div>
      </div>

      <div style="display: flex; gap: 0.75rem; align-items: center;">
        <button type="submit" class="btn">${isNew ? 'Create share-link' : 'Save changes'}</button>
        <a href="/share-links" class="btn secondary">Cancel</a>
      </div>
    </form>
  `;

  const composerScript = `<script>
    (function () {
      const all = ${pickerJson};
      let selected = ${selectedJson};
      const allVersions = ${versionsJson};
      let selectedVersions = ${selectedVersionsJson};
      const byId = Object.fromEntries(all.map(c => [c.id, c]));
      // Group versions by case study id for fast lookup in render()
      const versionsByCs = {};
      allVersions.forEach(v => { (versionsByCs[v.case_study_id] = versionsByCs[v.case_study_id] || []).push(v); });
      const avEl = document.getElementById('slAvailable');
      const seEl = document.getElementById('slSelected');
      const hidden = document.getElementById('case_study_ids');
      const versionsHidden = document.getElementById('case_study_versions');
      const countEl = document.getElementById('slCountBadge');

      function rowStyle() { return 'display:flex;align-items:center;gap:0.5rem;padding:0.5rem;border-radius:4px;border:1px solid transparent;'; }
      function statusBadge(s) {
        if (s === 'published') return '';
        return '<span style="background:rgba(247,179,43,0.12);color:#F7B32B;font-size:0.55rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:0.15rem 0.4rem;border-radius:100px;border:1px solid rgba(247,179,43,0.25);margin-left:0.4rem;">' + s + '</span>';
      }
      function escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

      function render() {
        // Available list = everything not in selected
        const sel = new Set(selected);
        avEl.innerHTML = '';
        all.filter(c => !sel.has(c.id)).forEach(c => {
          const row = document.createElement('div');
          row.style.cssText = rowStyle();
          row.innerHTML =
            '<button type="button" class="btn secondary" data-add="' + escAttr(c.id) + '" style="padding:0.2rem 0.5rem;font-size:0.7rem;">+ add</button>' +
            '<div style="flex:1;min-width:0;"><div style="font-size:0.85rem;font-weight:600;color:#E6EBE8;">' + escAttr(c.title) + statusBadge(c.status) + '</div><div style="font-size:0.7rem;color:#7E8F91;">' + escAttr(c.company) + '</div></div>';
          avEl.appendChild(row);
        });
        if (avEl.children.length === 0) {
          avEl.innerHTML = '<div style="font-size:0.78rem;color:#7E8F91;padding:0.6rem 0.5rem;">All case studies are in this share-link.</div>';
        }

        seEl.innerHTML = '';
        selected.forEach((id, i) => {
          const c = byId[id];
          if (!c) return;
          const row = document.createElement('div');
          row.style.cssText = rowStyle() + 'background:#122A2E;';
          row.draggable = true;
          row.dataset.id = c.id;

          // Build the version dropdown if this case study has versions.
          const versions = versionsByCs[c.id] || [];
          let versionSelectHtml = '';
          if (versions.length > 0) {
            const currentVid = selectedVersions[c.id] || '';
            const optionsHtml = ['<option value="">Canonical (default)</option>']
              .concat(versions.map(v => '<option value="' + escAttr(v.id) + '"' + (v.id === currentVid ? ' selected' : '') + '>' + escAttr(v.label) + '</option>'))
              .join('');
            versionSelectHtml =
              '<select data-version-for="' + escAttr(c.id) + '" style="background:#0D1B1E;border:1px solid #244549;color:#E6EBE8;font-size:0.65rem;border-radius:3px;padding:0.1rem 0.3rem;margin-left:0.4rem;max-width:11rem;">' +
              optionsHtml + '</select>';
          }

          row.innerHTML =
            '<span class="sl-drag" title="Drag to reorder" style="cursor:grab;color:#7E8F91;font-size:0.95rem;line-height:1;user-select:none;padding:0 0.15rem;">⋮⋮</span>' +
            '<span style="font-size:0.62rem;color:#7E8F91;font-weight:700;min-width:1.4rem;text-align:right;">' + (i+1) + '.</span>' +
            '<div style="flex:1;min-width:0;"><div style="font-size:0.85rem;font-weight:600;color:#E6EBE8;">' + escAttr(c.title) + statusBadge(c.status) + '</div><div style="font-size:0.7rem;color:#7E8F91;display:flex;align-items:center;flex-wrap:wrap;">' + escAttr(c.company) + versionSelectHtml + '</div></div>' +
            '<button type="button" class="btn secondary" data-up="' + escAttr(c.id) + '" ' + (i === 0 ? 'disabled' : '') + ' style="padding:0.15rem 0.4rem;font-size:0.7rem;">↑</button>' +
            '<button type="button" class="btn secondary" data-down="' + escAttr(c.id) + '" ' + (i === selected.length - 1 ? 'disabled' : '') + ' style="padding:0.15rem 0.4rem;font-size:0.7rem;">↓</button>' +
            '<button type="button" class="btn danger" data-remove="' + escAttr(c.id) + '" style="padding:0.15rem 0.4rem;font-size:0.7rem;">×</button>';
          seEl.appendChild(row);
        });
        if (seEl.children.length === 0) {
          seEl.innerHTML = '<div style="font-size:0.78rem;color:#7E8F91;padding:0.6rem 0.5rem;">Pick case studies from the left.</div>';
        }

        hidden.value = JSON.stringify(selected);
        // Prune versions for case studies that aren't in selected
        const sel2 = new Set(selected);
        Object.keys(selectedVersions).forEach(k => { if (!sel2.has(k)) delete selectedVersions[k]; });
        versionsHidden.value = JSON.stringify(selectedVersions);
        countEl.textContent = selected.length ? '(' + selected.length + ')' : '';
      }

      document.addEventListener('click', (e) => {
        const t = e.target;
        if (!(t && t.dataset)) return;
        if (t.dataset.add !== undefined) {
          const id = t.dataset.add;
          if (!selected.includes(id)) selected.push(id);
          render();
        } else if (t.dataset.remove !== undefined) {
          selected = selected.filter(x => x !== t.dataset.remove);
          render();
        } else if (t.dataset.up !== undefined) {
          const i = selected.indexOf(t.dataset.up);
          if (i > 0) { const tmp = selected[i-1]; selected[i-1] = selected[i]; selected[i] = tmp; }
          render();
        } else if (t.dataset.down !== undefined) {
          const i = selected.indexOf(t.dataset.down);
          if (i >= 0 && i < selected.length - 1) { const tmp = selected[i+1]; selected[i+1] = selected[i]; selected[i] = tmp; }
          render();
        } else if (t.dataset.copy !== undefined) {
          navigator.clipboard.writeText(t.dataset.copy).then(() => {
            const original = t.textContent; t.textContent = 'Copied'; setTimeout(() => { t.textContent = original; }, 1200);
          }).catch(() => {});
        }
      });

      // Version dropdown changes — store the selection without re-rendering
      // (re-rendering would reset focus and feel jumpy)
      seEl.addEventListener('change', (e) => {
        const t = e.target;
        if (!t || !t.dataset || t.dataset.versionFor === undefined) return;
        const csId = t.dataset.versionFor;
        if (t.value) selectedVersions[csId] = t.value;
        else delete selectedVersions[csId];
        versionsHidden.value = JSON.stringify(selectedVersions);
      });

      // ─── Drag-and-drop reorder for selected list ───
      // Box-shadow (not border) is used for the drop indicator so layout doesn't jitter.
      // ↑↓ buttons stay for touch / keyboard fallback.
      let dragId = null;
      function clearDropMarkers() {
        seEl.querySelectorAll('[data-id]').forEach((el) => { el.style.boxShadow = ''; });
      }
      seEl.addEventListener('dragstart', (e) => {
        const row = e.target.closest && e.target.closest('[data-id]');
        if (!row) return;
        dragId = row.dataset.id;
        row.style.opacity = '0.4';
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          // Required by Firefox to actually start a drag.
          try { e.dataTransfer.setData('text/plain', dragId); } catch (_) {}
        }
      });
      seEl.addEventListener('dragend', (e) => {
        const row = e.target.closest && e.target.closest('[data-id]');
        if (row) row.style.opacity = '';
        clearDropMarkers();
        dragId = null;
      });
      seEl.addEventListener('dragover', (e) => {
        const row = e.target.closest && e.target.closest('[data-id]');
        if (!dragId || !row || row.dataset.id === dragId) { clearDropMarkers(); return; }
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        clearDropMarkers();
        const rect = row.getBoundingClientRect();
        const above = e.clientY < rect.top + rect.height / 2;
        row.style.boxShadow = above ? '0 -2px 0 0 #E2403E' : '0 2px 0 0 #E2403E';
      });
      seEl.addEventListener('drop', (e) => {
        e.preventDefault();
        const row = e.target.closest && e.target.closest('[data-id]');
        clearDropMarkers();
        if (!row || !dragId || row.dataset.id === dragId) return;
        const targetId = row.dataset.id;
        const rect = row.getBoundingClientRect();
        const above = e.clientY < rect.top + rect.height / 2;
        const fromIdx = selected.indexOf(dragId);
        if (fromIdx === -1) return;
        selected.splice(fromIdx, 1);
        let toIdx = selected.indexOf(targetId);
        if (!above) toIdx += 1;
        selected.splice(toIdx, 0, dragId);
        render();
      });

      render();
    })();
  </script>`;

  return new Response(shell({
    title: isNew ? 'New share-link' : `Edit ${row!.name}`,
    activeNav: 'share-links',
    body,
    toast: readToast(url),
    trailingScript: composerScript,
  }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

// ─── share-links: actions ────────────────────────────────────────────────

async function saveShareLink(request: Request, env: Env, idOrNull: string | null): Promise<Response> {
  const url = new URL(request.url);
  const ct = request.headers.get('Content-Type') ?? '';
  if (!ct.startsWith('multipart/form-data') && !ct.startsWith('application/x-www-form-urlencoded')) {
    return Response.json({ error: 'multipart/form-data or urlencoded required' }, { status: 400 });
  }

  const form = await request.formData();
  const failPath = idOrNull ? `/share-links/${idOrNull}` : '/share-links/new';

  const name = String(form.get('name') ?? '').trim();
  const recipient_label = String(form.get('recipient_label') ?? '').trim() || null;
  const custom_headline = String(form.get('custom_headline') ?? '').trim() || null;
  const custom_message = String(form.get('custom_message') ?? '').trim() || null;

  // Slug: optional. Empty → null. Non-empty must match SHORT_SLUG_RE,
  // not be reserved, and not collide with another link's slug.
  const slugRaw = String(form.get('slug') ?? '').trim().toLowerCase();
  let slug: string | null = null;
  if (slugRaw) {
    if (!SHORT_SLUG_RE.test(slugRaw)) {
      return redirectWithToast(url, failPath, 'error', 'Slug must be 3-40 chars, lowercase a-z / 0-9 / hyphens, starting and ending alphanumeric.');
    }
    if (RESERVED_SLUGS.has(slugRaw)) {
      return redirectWithToast(url, failPath, 'error', `Slug "${slugRaw}" is reserved. Pick another.`);
    }
    if (await isSlugTaken(env, slugRaw, idOrNull)) {
      return redirectWithToast(url, failPath, 'error', `Slug "${slugRaw}" is already used by another share-link.`);
    }
    slug = slugRaw;
  }

  const caseIdsRaw = String(form.get('case_study_ids') ?? '[]');
  let caseIds: string[] = [];
  try {
    const parsed = JSON.parse(caseIdsRaw);
    if (Array.isArray(parsed)) caseIds = parsed.filter((x: unknown): x is string => typeof x === 'string');
  } catch { /* empty */ }

  // Optional case_study_versions: { csId: versionId }. Filter to selected
  // case studies only (composer prunes too, but defense in depth).
  const versionsRaw = String(form.get('case_study_versions') ?? '{}');
  let caseStudyVersionsObj: Record<string, string> = {};
  try {
    const parsed = JSON.parse(versionsRaw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const csIdSet = new Set(caseIds);
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' && v && csIdSet.has(k)) caseStudyVersionsObj[k] = v;
      }
    }
  } catch { /* empty */ }
  const case_study_versions: string | null =
    Object.keys(caseStudyVersionsObj).length > 0 ? JSON.stringify(caseStudyVersionsObj) : null;

  if (!name) return redirectWithToast(url, failPath, 'error', 'Internal name is required.');
  if (caseIds.length === 0) return redirectWithToast(url, failPath, 'error', 'Pick at least one case study.');

  // Expiry: HTML date input → end-of-day UTC seconds
  const expiryStr = String(form.get('expires_at') ?? '').trim();
  let expires_at: number | null = null;
  if (expiryStr) {
    const parsed = Date.parse(expiryStr + 'T23:59:59Z');
    if (!isNaN(parsed)) expires_at = Math.floor(parsed / 1000);
  }

  // Password: blank means "no change" on edit; "remove" removes; else set
  const passwordInput = String(form.get('password') ?? '');
  let password_hash: string | null | undefined; // undefined = leave alone, null = clear, string = set
  if (passwordInput === '') password_hash = undefined;
  else if (passwordInput.trim().toLowerCase() === 'remove') password_hash = null;
  else password_hash = await hashPassword(passwordInput);

  // Resume upload (optional)
  let new_resume_key: string | null | undefined;
  let new_resume_name: string | null | undefined;
  const removeResume = String(form.get('remove_resume') ?? '') === '1';

  const fileEntry = form.get('resume');
  const hasFile = fileEntry && typeof fileEntry !== 'string' && typeof (fileEntry as any).stream === 'function' && (fileEntry as any).size > 0;
  if (hasFile) {
    const file = fileEntry as unknown as { name: string; type: string; size: number; stream(): ReadableStream };
    if (file.size > MAX_PDF_BYTES) {
      return redirectWithToast(url, failPath, 'error', `Resume PDF too large (max ${MAX_PDF_BYTES / 1024 / 1024} MB).`);
    }
    if (!PDF_MIME_TYPES.has(file.type) && !file.name.toLowerCase().endsWith('.pdf')) {
      return redirectWithToast(url, failPath, 'error', 'Resume must be a PDF.');
    }
    const safeBase = file.name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || 'resume.pdf';
    const key = `resumes/${nowSeconds()}-${randomToken(4)}-${safeBase}${safeBase.toLowerCase().endsWith('.pdf') ? '' : '.pdf'}`;
    await env.PRIVATE_BUCKET.put(key, file.stream(), {
      httpMetadata: { contentType: 'application/pdf' },
    });
    new_resume_key = key;
    new_resume_name = safeBase.endsWith('.pdf') ? safeBase : `${safeBase}.pdf`;
  } else if (removeResume) {
    new_resume_key = null;
    new_resume_name = null;
  }

  if (idOrNull === null) {
    // CREATE
    const id = newShareLinkId();
    const token = newShareToken();
    try {
      await env.DB.prepare(
        `INSERT INTO share_links
           (id, token, name, recipient_label, case_study_ids, resume_file_key,
            resume_file_name, custom_headline, custom_message, password_hash,
            created_at, expires_at, last_viewed_at, slug, case_study_versions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), ?, NULL, ?, ?)`
      ).bind(
        id, token, name, recipient_label, JSON.stringify(caseIds),
        new_resume_key ?? null, new_resume_name ?? null,
        custom_headline, custom_message,
        password_hash === undefined ? null : password_hash,
        expires_at,
        slug,
        case_study_versions,
      ).run();
    } catch (e: any) {
      // Roll back the orphaned R2 upload if insert failed
      if (new_resume_key) {
        try { await env.PRIVATE_BUCKET.delete(new_resume_key); } catch { /* swallow */ }
      }
      return redirectWithToast(url, '/share-links/new', 'error', `Create failed: ${e?.message ?? e}`);
    }
    return redirectWithToast(url, `/share-links/${id}`, 'success', 'Share-link created.');
  }

  // UPDATE
  const existing = await getShareLink(env, idOrNull);
  if (!existing) return redirectWithToast(url, '/share-links', 'error', 'Share-link not found.');

  // Build dynamic SET. We always update name/recipient/case_ids/headline/message/expires_at.
  // Conditionally update password and resume.
  const sets: string[] = [
    'name = ?', 'recipient_label = ?', 'case_study_ids = ?',
    'custom_headline = ?', 'custom_message = ?', 'expires_at = ?',
    'slug = ?', 'case_study_versions = ?',
  ];
  const binds: any[] = [name, recipient_label, JSON.stringify(caseIds), custom_headline, custom_message, expires_at, slug, case_study_versions];

  if (password_hash !== undefined) { sets.push('password_hash = ?'); binds.push(password_hash); }
  if (new_resume_key !== undefined) { sets.push('resume_file_key = ?'); binds.push(new_resume_key); }
  if (new_resume_name !== undefined) { sets.push('resume_file_name = ?'); binds.push(new_resume_name); }

  binds.push(idOrNull);
  await env.DB.prepare(`UPDATE share_links SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();

  // Garbage-collect old resume if we replaced or removed it
  if ((new_resume_key !== undefined || removeResume) && existing.resume_file_key && existing.resume_file_key !== new_resume_key) {
    try { await env.PRIVATE_BUCKET.delete(existing.resume_file_key); } catch { /* swallow */ }
  }

  return redirectWithToast(url, `/share-links/${idOrNull}`, 'success', 'Saved.');
}

async function deleteShareLink(env: Env, id: string): Promise<Response> {
  const existing = await getShareLink(env, id);
  if (!existing) return new Response(null, { status: 303, headers: { Location: '/share-links?toast=Not%20found&kind=error' } });
  // Cascade view rows + drop the row
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM share_link_views WHERE share_link_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM share_links WHERE id = ?`).bind(id),
  ]);
  if (existing.resume_file_key) {
    try { await env.PRIVATE_BUCKET.delete(existing.resume_file_key); } catch { /* swallow */ }
  }
  return new Response(null, { status: 303, headers: { Location: '/share-links?toast=Deleted&kind=success' } });
}

// ─── share-links: per-link analytics page ────────────────────────────────

interface DailyEventRow { day: string; event: string; n: number }
interface PerCsRow { id: string; title: string | null; company: string | null; n: number }
interface RecentRow {
  viewed_at: number;
  event: string;
  case_study_id: string | null;
  user_agent: string | null;
  referrer: string | null;
}

function eventBadge(event: string): string {
  const colors: Record<string, [string, string]> = {
    open: ['rgba(226,64,62,0.15)', '#E2403E'],
    card_click: ['rgba(142,236,177,0.12)', '#8eecb1'],
    resume_download: ['rgba(247,179,43,0.12)', '#F7B32B'],
    unlock_failed: ['rgba(255,107,107,0.12)', '#ff6b6b'],
  };
  const [bg, fg] = colors[event] ?? ['rgba(124,109,144,0.12)', '#8B9698'];
  return `<span style="background:${bg};color:${fg};font-size:0.6rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:0.18rem 0.45rem;border-radius:100px;white-space:nowrap;">${htmlEscape(event.replace(/_/g, ' '))}</span>`;
}

function shortUA(ua: string): string {
  // Cheap heuristic. Just enough to tell devices apart in the activity feed.
  const m = ua.match(/(Chrome|Firefox|Safari|Edge|OPR|Brave)\/[\d.]+/);
  let os = '';
  if (/Windows NT/.test(ua)) os = ' Windows';
  else if (/iPhone|iPad/.test(ua)) os = ' iOS';
  else if (/Android/.test(ua)) os = ' Android';
  else if (/Mac OS X|Macintosh/.test(ua)) os = ' macOS';
  else if (/Linux/.test(ua)) os = ' Linux';
  return (m ? m[0] : ua.slice(0, 40)) + os;
}

function shortRef(ref: string): string {
  try { const u = new URL(ref); return u.hostname; } catch { return ref.slice(0, 30); }
}

async function analyticsShareLinkPage(env: Env, id: string, url: URL): Promise<Response> {
  let link: ShareLinkRow | null = null;
  try { link = await getShareLink(env, id); } catch (e: any) {
    return new Response(`Schema not applied yet: ${e?.message ?? e}`, { status: 500 });
  }
  if (!link) return new Response('Not found', { status: 404 });

  // Aggregate per-event totals
  const eventRes = await env.DB.prepare(
    `SELECT event, COUNT(*) as n FROM share_link_views WHERE share_link_id = ? GROUP BY event`
  ).bind(id).all<{ event: string; n: number }>();
  const counts: Record<string, number> = { open: 0, card_click: 0, resume_download: 0, unlock_failed: 0 };
  for (const r of eventRes.results ?? []) counts[r.event] = r.n;

  // Per case-study card-click counts. LEFT JOIN so a case study that's been
  // unpublished or renamed still shows by id.
  const perCsRes = await env.DB.prepare(
    `SELECT v.case_study_id as id, c.title as title, c.company as company, COUNT(*) as n
       FROM share_link_views v
       LEFT JOIN case_studies c ON c.id = v.case_study_id
      WHERE v.share_link_id = ? AND v.event = 'card_click' AND v.case_study_id IS NOT NULL
      GROUP BY v.case_study_id
      ORDER BY n DESC`
  ).bind(id).all<PerCsRow>();

  // Daily breakdown — last 30 days
  const dailyRes = await env.DB.prepare(
    `SELECT date(viewed_at, 'unixepoch') as day, event, COUNT(*) as n
       FROM share_link_views
      WHERE share_link_id = ? AND viewed_at >= unixepoch() - 30 * 86400
      GROUP BY day, event
      ORDER BY day ASC`
  ).bind(id).all<DailyEventRow>();

  // Recent activity
  const recentRes = await env.DB.prepare(
    `SELECT viewed_at, event, case_study_id, user_agent, referrer
       FROM share_link_views
      WHERE share_link_id = ?
      ORDER BY viewed_at DESC
      LIMIT 50`
  ).bind(id).all<RecentRow>();

  // Build a 30-day grid (oldest → newest) so empty days show as gaps
  const days: string[] = [];
  const todayMs = Date.now();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(todayMs - i * 86400_000);
    days.push(d.toISOString().slice(0, 10));
  }
  const dailyMap: Record<string, Record<string, number>> = {};
  for (const r of dailyRes.results ?? []) {
    if (!dailyMap[r.day]) dailyMap[r.day] = {};
    dailyMap[r.day][r.event] = r.n;
  }
  const dailyMax = Math.max(1, ...days.map((d) => Object.values(dailyMap[d] ?? {}).reduce((a, b) => a + b, 0)));

  function tile(label: string, value: number, color: string): string {
    return `<div style="background:#122A2E;border:1px solid #1B3A3F;border-radius:8px;padding:1rem 1.1rem;">
      <div style="font-size:0.6rem;text-transform:uppercase;letter-spacing:0.1em;color:#7E8F91;margin-bottom:0.4rem;">${label}</div>
      <div style="font-size:1.85rem;font-weight:700;color:${color};font-variant-numeric:tabular-nums;line-height:1.1;">${value.toLocaleString()}</div>
    </div>`;
  }

  const bars = days.map((d) => {
    const events = dailyMap[d] ?? {};
    const total = Object.values(events).reduce((a, b) => a + b, 0);
    const heightPct = (total / dailyMax) * 100;
    const tooltip = `${d} • ${total} event${total === 1 ? '' : 's'}\n` +
      `open: ${events.open ?? 0} | click: ${events.card_click ?? 0} | resume: ${events.resume_download ?? 0} | fail: ${events.unlock_failed ?? 0}`;
    return `<div style="flex:1;display:flex;flex-direction:column;align-items:stretch;justify-content:flex-end;height:140px;min-width:8px;" title="${attrEscape(tooltip)}">
      <div style="width:100%;background:${total > 0 ? '#E2403E' : '#1B3A3F'};height:${total > 0 ? Math.max(heightPct, 4) : 2}%;border-radius:2px 2px 0 0;"></div>
    </div>`;
  }).join('');
  const xLabels = days.map((d, i) => {
    // Only show every 5th label to avoid clutter
    return i % 5 === 0 ? `<div style="flex:1;text-align:left;font-size:0.6rem;color:#7E8F91;font-variant-numeric:tabular-nums;min-width:8px;">${htmlEscape(d.slice(5))}</div>` : `<div style="flex:1;min-width:8px;"></div>`;
  }).join('');

  const csRows = (perCsRes.results ?? []).map((r) => {
    const title = r.title ?? r.id;
    const company = r.company ?? '';
    return `<tr>
      <td><div style="font-weight:600;color:#E6EBE8;">${htmlEscape(title)}</div><div class="small" style="color:#7E8F91;">${htmlEscape(company)} · <code>${htmlEscape(r.id)}</code></div></td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;font-weight:700;color:#E2403E;font-size:1rem;">${r.n}</td>
    </tr>`;
  }).join('');

  const recentRows = (recentRes.results ?? []).map((r) => {
    const t = new Date(r.viewed_at * 1000);
    const ts = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')} ${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
    const detail = r.case_study_id ? `<code style="color:#8B9698;">${htmlEscape(r.case_study_id)}</code>` : '<span style="color:#7E8F91;">—</span>';
    const ua = r.user_agent ? shortUA(r.user_agent) : '—';
    const ref = r.referrer ? ' ← ' + shortRef(r.referrer) : '';
    return `<tr>
      <td class="small" style="color:#7E8F91;font-variant-numeric:tabular-nums;white-space:nowrap;">${htmlEscape(ts)}Z</td>
      <td>${eventBadge(r.event)}</td>
      <td class="small">${detail}</td>
      <td class="small" style="color:#7E8F91;">${htmlEscape(ua + ref)}</td>
    </tr>`;
  }).join('');

  const publicUrl = preferredPublicUrl(link);
  const totalEvents = (counts.open ?? 0) + (counts.card_click ?? 0) + (counts.resume_download ?? 0) + (counts.unlock_failed ?? 0);

  const body = `
    <div class="toolbar">
      <a href="/share-links" class="small" style="color:#8B9698;">← All share-links</a>
      <a href="/share-links/${attrEscape(id)}" class="small" style="color:#8B9698;">Edit this link</a>
    </div>
    <h2>${htmlEscape(link.name)} <span style="color:#7E8F91;font-weight:400;">— Analytics</span></h2>
    <p class="sub">
      Created ${htmlEscape(formatTimestamp(link.created_at))}.
      ${link.last_viewed_at ? 'Last viewed ' + htmlEscape(formatTimestamp(link.last_viewed_at)) + '.' : 'Not yet opened.'}
      <br><a href="${attrEscape(publicUrl)}" target="_blank" rel="noopener" style="color:#E2403E;">${htmlEscape(publicUrl)}</a>
    </p>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1rem;margin-bottom:1.5rem;">
      ${tile('Opens', counts.open ?? 0, '#E2403E')}
      ${tile('Card clicks', counts.card_click ?? 0, '#8eecb1')}
      ${tile('Resume downloads', counts.resume_download ?? 0, '#F7B32B')}
      ${tile('Unlock failures', counts.unlock_failed ?? 0, '#ff6b6b')}
    </div>

    <h3 style="margin-top:2rem;font-size:0.95rem;color:#E6EBE8;">Last 30 days · ${totalEvents} event${totalEvents === 1 ? '' : 's'} total</h3>
    <div style="background:#122A2E;border:1px solid #1B3A3F;border-radius:8px;padding:1rem;">
      <div style="display:flex;align-items:flex-end;gap:0.15rem;">${bars}</div>
      <div style="display:flex;gap:0.15rem;margin-top:0.4rem;">${xLabels}</div>
      <div class="small" style="color:#7E8F91;margin-top:0.5rem;">Hover a bar for the per-event breakdown.</div>
    </div>

    <h3 style="margin-top:2rem;font-size:0.95rem;color:#E6EBE8;">Card clicks by case study</h3>
    ${csRows ? `<table class="list">
      <thead><tr><th>Case study</th><th style="text-align:right;">Clicks</th></tr></thead>
      <tbody>${csRows}</tbody>
    </table>` : '<p class="sub" style="color:#7E8F91;">No card clicks yet.</p>'}

    <h3 style="margin-top:2rem;font-size:0.95rem;color:#E6EBE8;">Recent activity (last 50 events)</h3>
    ${recentRows ? `<table class="list">
      <thead><tr><th>When (UTC)</th><th>Event</th><th>Case study</th><th>Browser · referrer</th></tr></thead>
      <tbody>${recentRows}</tbody>
    </table>` : '<p class="sub" style="color:#7E8F91;">No events yet.</p>'}
  `;

  return new Response(shell({
    title: `${link.name} — Analytics`,
    activeNav: 'share-links',
    body,
    toast: readToast(url),
  }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}
