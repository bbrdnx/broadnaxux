/**
 * broadnaxux-public — serves barbarabroadnax.com.
 *
 * Phase 1 + Phase 2 routes:
 *   GET  /                       homepage rendered from site_content + published case_studies
 *   GET  /work/:slug             case study rendered from case_studies
 *   GET  /:slug.html             301 redirect to /work/:slug (back-compat with the old URLs)
 *   GET  /share/:token           share-link landing (password-gated if configured)
 *   POST /share/:token/unlock    submits password, sets cookie
 *   GET  /share/:token/resume    serves resume PDF (cookie-gated when password is set)
 *   POST /share/:token/track     beacon endpoint for case-study card opens
 *   GET  /__health               DB connectivity probe (returns JSON)
 *   *                            everything else falls through to static assets (images, css, resume, etc.)
 *
 * The renderers are intentionally self-contained: they reassemble the same
 * HTML/CSS/JS that `index.html` and the per-case-study HTML files produced
 * statically, but populate the dynamic bits from D1.
 */

export interface Env {
  DB: D1Database;
  PUBLIC_BUCKET: R2Bucket;
  PRIVATE_BUCKET: R2Bucket;
  ASSETS: Fetcher;
}

// ─── slugs that map to the old static *.html URLs we want to redirect ─────

const LEGACY_HTML_REDIRECTS = new Set([
  'ipro-ner',
  'inksoft-design-studio',
  'alaska-view-reservation',
  'ipro-search-redact',
  'ipro-eda',
  'alaska-same-day-change',
  'inksoft-ssl',
]);

// Slug character class: lowercase letters, digits, hyphens.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// ─── entrypoint ──────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/__health' && method === 'GET') return handleHealth(env);

    // R2-backed uploads (admin posts here, public reads from same bucket).
    if ((method === 'GET' || method === 'HEAD') && path.startsWith('/uploads/')) {
      return serveUpload(env, path.slice('/uploads/'.length), method === 'HEAD');
    }

    if ((method === 'GET' || method === 'HEAD') && path === '/') {
      return renderHomepage(env, method === 'HEAD');
    }

    // /work/:slug — published case study (optional ?v=<version_id> for variant)
    if ((method === 'GET' || method === 'HEAD') && path.startsWith('/work/')) {
      const slug = path.slice('/work/'.length);
      if (!SLUG_RE.test(slug)) return notFound();
      const versionId = url.searchParams.get('v');
      return renderCaseStudy(env, slug, method === 'HEAD', versionId);
    }

    // /share/:token and sub-routes
    const shareMatch = path.match(/^\/share\/([A-Za-z0-9_-]+)(?:\/(unlock|resume|track))?$/);
    if (shareMatch) {
      const token = shareMatch[1];
      const action = shareMatch[2];
      if (!action && (method === 'GET' || method === 'HEAD')) return renderShareLink(env, request, token, method === 'HEAD');
      if (action === 'unlock' && method === 'POST') return handleShareUnlock(env, request, token);
      if (action === 'resume' && (method === 'GET' || method === 'HEAD')) return serveShareResume(env, request, token, method === 'HEAD');
      if (action === 'track'  && method === 'POST') return handleShareTrack(env, request, token);
    }

    // /r/:slug — short-link alias. Looks up the canonical token and 302's
    // to /share/:token. We deliberately don't render under /r/ to avoid
    // duplicating sub-routes (unlock, resume, track) and re-scoping cookies.
    const shortMatch = path.match(/^\/r\/([a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?)$/);
    if (shortMatch && (method === 'GET' || method === 'HEAD')) {
      return resolveShortLink(env, shortMatch[1]);
    }

    // /:slug.html — back-compat 301 to /work/:slug (only for our known case studies)
    if (method === 'GET' && path.endsWith('.html') && path !== '/index.html') {
      const slug = path.slice(1, -'.html'.length);
      if (LEGACY_HTML_REDIRECTS.has(slug)) {
        return Response.redirect(new URL(`/work/${slug}`, url).toString(), 301);
      }
    }

    // /index.html → /
    if (method === 'GET' && path === '/index.html') {
      return Response.redirect(new URL('/', url).toString(), 301);
    }

    // Everything else: static assets (images, styles.css, resume.html, etc.)
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

// ─── data access ─────────────────────────────────────────────────────────

interface CaseStudyRow {
  id: string;
  title: string;
  company: string;
  role: string | null;
  outcome_metric: string | null;
  hero_image_key: string | null;
  body_html: string;
  status: string;
  sort_order: number;
  subtitle: string | null;
  about_html: string | null;
  meta_items: string | null; // JSON array of {label, value}
  meta_role: string | null;
  meta_team: string | null;
  meta_rating: string | null;
}

interface MetaItem { label: string; value: string; }

async function loadPublishedCaseStudies(env: Env): Promise<CaseStudyRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, company, role, outcome_metric, hero_image_key, body_html,
            status, sort_order, subtitle, about_html, meta_items,
            meta_role, meta_team, meta_rating
       FROM case_studies
      WHERE status = 'published'
   ORDER BY sort_order ASC, created_at ASC`
  ).all<CaseStudyRow>();
  return results ?? [];
}

async function loadCaseStudyBySlug(env: Env, slug: string): Promise<CaseStudyRow | null> {
  return env.DB.prepare(
    `SELECT id, title, company, role, outcome_metric, hero_image_key, body_html,
            status, sort_order, subtitle, about_html, meta_items,
            meta_role, meta_team, meta_rating
       FROM case_studies
      WHERE id = ? AND status = 'published'`
  ).bind(slug).first<CaseStudyRow>();
}

async function loadSiteContent(env: Env): Promise<Record<string, { value: string; type: string }>> {
  const { results } = await env.DB.prepare(
    `SELECT key, value, value_type FROM site_content`
  ).all<{ key: string; value: string; value_type: string }>();
  const out: Record<string, { value: string; type: string }> = {};
  for (const r of results ?? []) {
    out[r.key] = { value: r.value, type: r.value_type };
  }
  return out;
}

function getText(content: Record<string, { value: string; type: string }>, key: string, fallback = ''): string {
  return content[key]?.value ?? fallback;
}

function getJSON<T>(content: Record<string, { value: string; type: string }>, key: string, fallback: T): T {
  const raw = content[key]?.value;
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function metaItemsFromRow(row: CaseStudyRow): MetaItem[] {
  if (row.meta_items) {
    try {
      const parsed = JSON.parse(row.meta_items);
      if (Array.isArray(parsed)) return parsed as MetaItem[];
    } catch { /* fall through */ }
  }
  // Legacy fallback: meta_role / meta_team / meta_rating
  const items: MetaItem[] = [];
  if (row.meta_role)   items.push({ label: 'Role',        value: row.meta_role });
  if (row.meta_team)   items.push({ label: 'Team',        value: row.meta_team });
  if (row.meta_rating) items.push({ label: 'User Rating', value: row.meta_rating });
  return items;
}

// ─── escape helpers ──────────────────────────────────────────────────────

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attrEscape(s: string): string {
  return htmlEscape(s);
}

// ─── homepage renderer ───────────────────────────────────────────────────

async function renderHomepage(env: Env, headOnly: boolean): Promise<Response> {
  const [caseStudies, content] = await Promise.all([
    loadPublishedCaseStudies(env),
    loadSiteContent(env),
  ]);

  const tickerPhrases = getJSON<string[]>(content, 'ticker_phrases', []);
  const tickerLabel   = getText(content, 'ticker_label', 'I design');
  const thesis1       = getText(content, 'thesis_line_1');
  const thesis2       = getText(content, 'thesis_line_2');
  const asterisk      = getText(content, 'asterisk_tooltip');
  const coEyebrow     = getText(content, 'co_eyebrow', 'The companies');
  const companyRows   = getJSON<Array<{ index?: string; name: string; industry: string; description: string }>>(content, 'company_context', []);
  const recordHeader  = getJSON<string[]>(content, 'record_header', ['Company', 'Project', 'Role', 'Outcome']);
  const inter1        = getText(content, 'interstitial_paragraph_1');
  const inter2        = getText(content, 'interstitial_paragraph_2');
  const interAfter    = parseInt(getText(content, 'interstitial_after_position', '3'), 10) || 3;
  const spEyebrow     = getText(content, 'side_projects_eyebrow', 'Now building');
  const spHeadline    = getText(content, 'side_projects_headline');
  const spLead        = getText(content, 'side_projects_lead');
  const spQuote       = getText(content, 'side_projects_quote');
  const spCite        = getText(content, 'side_projects_quote_cite');
  const footerEmail   = getText(content, 'footer_email', 'broadnaxux@gmail.com');
  const footerLinkedIn= getText(content, 'footer_linkedin', 'https://www.linkedin.com/in/barbarabroadnax');

  // Build the work record rows. Insert the interstitial after the Nth row.
  const rows: string[] = [];
  caseStudies.forEach((cs, i) => {
    rows.push(workRecordRow(cs));
    if (i + 1 === interAfter && (inter1 || inter2)) {
      rows.push(interstitialBlock(inter1, inter2));
    }
  });

  const html = homepageTemplate({
    tickerPhrases, tickerLabel,
    thesis1, thesis2, asterisk,
    coEyebrow, companyRows,
    recordHeader,
    workRowsHtml: rows.join('\n\n'),
    spEyebrow, spHeadline, spLead, spQuote, spCite,
    footerEmail, footerLinkedIn,
  });

  return new Response(headOnly ? null : html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Short edge cache. Admin edits propagate within ~60s.
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=600',
    },
  });
}

function workRecordRow(cs: CaseStudyRow): string {
  return `    <a href="/work/${attrEscape(cs.id)}" class="record-row">
      <span class="record-company">${htmlEscape(cs.company)}</span>
      <span class="record-project">${htmlEscape(cs.title)}</span>
      <span class="record-role">${htmlEscape(cs.role ?? '')}</span>
      <span class="record-outcome">${htmlEscape(cs.outcome_metric ?? '')}</span>
      <span class="record-arrow" aria-hidden="true">&#8599;</span>
    </a>`;
}

function interstitialBlock(p1: string, p2: string): string {
  // p1 / p2 are stored as HTML so <strong> tags survive. Don't escape.
  return `    <div class="interstitial">
      <p id="interstitial-text">${p1}</p>
      ${p2 ? `<p id="interstitial-text-2" style="margin-top: 1.25rem;">${p2}</p>` : ''}
    </div>`;
}

// ─── case study renderer ─────────────────────────────────────────────────

interface CaseStudyVersionRow {
  id: string;
  case_study_id: string;
  label: string;
  subtitle: string | null;
  about_html: string | null;
  body_html: string | null;
  meta_items: string | null;
}

async function loadCaseStudyVersion(env: Env, versionId: string, caseStudyId: string): Promise<CaseStudyVersionRow | null> {
  // Bind version id AND case study id — prevents cross-study version leak
  // if someone tries /work/foo?v=<version_for_bar>.
  try {
    return await env.DB.prepare(
      `SELECT id, case_study_id, label, subtitle, about_html, body_html, meta_items
         FROM case_study_versions
        WHERE id = ? AND case_study_id = ?`
    ).bind(versionId, caseStudyId).first<CaseStudyVersionRow>();
  } catch {
    // Migration 0006 not applied yet — versions feature is gracefully off.
    return null;
  }
}

// Version id format: same shape as case-study-version IDs the admin generates.
// Permissive enough to cover base64url with hyphens/underscores.
const VERSION_ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

async function renderCaseStudy(env: Env, slug: string, headOnly: boolean, versionId: string | null = null): Promise<Response> {
  const cs = await loadCaseStudyBySlug(env, slug);
  if (!cs) return notFound();

  // Optional version override. If the version id is malformed or doesn't
  // belong to this case study, render the canonical page rather than 404 —
  // the share-link is still valid, the version reference is just stale.
  let version: CaseStudyVersionRow | null = null;
  if (versionId && VERSION_ID_RE.test(versionId)) {
    version = await loadCaseStudyVersion(env, versionId, cs.id);
  }

  // Prev/next always come from the canonical list, regardless of version.
  const all = await loadPublishedCaseStudies(env);
  const idx = all.findIndex((x) => x.id === cs.id);
  const prev = idx > 0 ? all[idx - 1] : null;
  const next = idx >= 0 && idx < all.length - 1 ? all[idx + 1] : null;

  // Field-level inheritance: version's non-null field wins, else canonical.
  const subtitle = (version?.subtitle ?? cs.subtitle) ?? '';
  const about_html = (version?.about_html ?? cs.about_html) ?? '';
  const body_html = version?.body_html ?? cs.body_html;
  const meta = version?.meta_items
    ? metaItemsFromVersion(version.meta_items, cs)
    : metaItemsFromRow(cs);

  const content = await loadSiteContent(env);
  const tickerPhrases = getJSON<string[]>(content, 'ticker_phrases', []);
  const tickerLabel   = getText(content, 'ticker_label', 'I design');
  const footerEmail   = getText(content, 'footer_email', 'broadnaxux@gmail.com');
  const footerLinkedIn= getText(content, 'footer_linkedin', 'https://www.linkedin.com/in/barbarabroadnax');

  const html = caseStudyTemplate({
    title: cs.title,
    company: cs.company,
    subtitle,
    about_html,
    meta,
    body_html,
    prev, next,
    tickerPhrases, tickerLabel,
    footerEmail, footerLinkedIn,
  });

  return new Response(headOnly ? null : html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Versions shouldn't be cached as long as canonical because they're
      // transient and recipient-specific. noindex on version variants too.
      'Cache-Control': version ? 'private, no-store' : 'public, max-age=60, stale-while-revalidate=600',
      ...(version ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
    },
  });
}

function metaItemsFromVersion(versionMetaJson: string, fallback: CaseStudyRow): MetaItem[] {
  try {
    const parsed = JSON.parse(versionMetaJson);
    if (Array.isArray(parsed)) return parsed as MetaItem[];
  } catch { /* fall through */ }
  return metaItemsFromRow(fallback);
}

// ─── shared partials ─────────────────────────────────────────────────────

function tickerScript(phrases: string[]): string {
  // Same animation as the hand-coded HTML, just with phrases injected.
  const json = JSON.stringify(phrases);
  return `
    /* Ticker */
    const phrases = ${json};
    const track = document.getElementById('ticker');
    let current = 0;
    phrases.forEach((p, i) => {
      const span = document.createElement('span');
      span.className = 'ticker-word';
      span.textContent = p;
      span.id = 'tw-' + i;
      track.appendChild(span);
    });
    function showWord(i) {
      const el = document.getElementById('tw-' + i);
      el.classList.add('is-in');
      el.addEventListener('animationend', () => { el.classList.remove('is-in'); el.style.opacity = 1; el.style.transform = 'translateY(0)'; }, { once: true });
    }
    function hideWord(i) {
      const el = document.getElementById('tw-' + i);
      el.style.opacity = ''; el.style.transform = '';
      el.classList.add('is-out');
      el.addEventListener('animationend', () => { el.classList.remove('is-out'); el.style.opacity = 0; }, { once: true });
    }
    if (track && phrases.length) {
      showWord(0);
      setInterval(() => { hideWord(current); current = (current + 1) % phrases.length; setTimeout(() => showWord(current), 320); }, 2600);
    }
`;
}

function navHtml(tickerLabel: string): string {
  return `  <nav>
    <a href="/" class="site-name" aria-label="Barbara Broadnax, home">
      <span class="name-first">Barbara</span>
      <span class="name-last">Broadnax</span>
    </a>
    <div class="nav-divider" aria-hidden="true"></div>
    <div class="ticker">
      <span class="ticker-label">${htmlEscape(tickerLabel)}</span>
      <div class="ticker-track" id="ticker" aria-live="polite"></div>
    </div>
    <ul class="nav-links">
      <li><a href="/#work">Work</a></li>
      <li><a href="/resume.html">Resume</a></li>
      <li><a href="https://www.linkedin.com/in/barbarabroadnax" target="_blank" rel="noopener">LinkedIn</a></li>
      <li><a href="/contact.html">Contact</a></li>
    </ul>
  </nav>`;
}

function footerHtml(email: string, linkedin: string): string {
  return `  <footer>
    <p>&copy; 2026 Barbara Broadnax</p>
    <ul class="footer-links">
      <li><a href="mailto:${attrEscape(email)}">Email</a></li>
      <li><a href="${attrEscape(linkedin)}" target="_blank" rel="noopener">LinkedIn</a></li>
    </ul>
  </footer>`;
}

// ─── homepage template ───────────────────────────────────────────────────

interface HomeData {
  tickerPhrases: string[];
  tickerLabel: string;
  thesis1: string;
  thesis2: string;
  asterisk: string;
  coEyebrow: string;
  companyRows: Array<{ index?: string; name: string; industry: string; description: string }>;
  recordHeader: string[];
  workRowsHtml: string;
  spEyebrow: string;
  spHeadline: string;
  spLead: string;
  spQuote: string;
  spCite: string;
  footerEmail: string;
  footerLinkedIn: string;
}

function homepageTemplate(d: HomeData): string {
  const headerCells = d.recordHeader.map((h) => `<span>${htmlEscape(h)}</span>`).join('\n      ');
  const companyHtml = d.companyRows.map((c, i) => `
    <div class="co-row">
      <span class="co-index">${htmlEscape(c.index ?? String(i + 1).padStart(2, '0'))}</span>
      <span class="co-name">${htmlEscape(c.name)}</span>
      <div class="co-right">
        <span class="co-industry">${htmlEscape(c.industry)}</span>
        <p class="co-desc">${htmlEscape(c.description)}</p>
      </div>
    </div>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Barbara Broadnax | Product & Design</title>
  <meta name="description" content="Senior Product Designer shipping work across legal tech, aviation, and e-commerce. Case studies on accessibility and design that performs.">

  <meta property="og:type" content="website">
  <meta property="og:title" content="Barbara Broadnax | Product & Design">
  <meta property="og:description" content="Senior Product Designer shipping work across legal tech, aviation, and e-commerce. Case studies on accessibility and design that performs.">
  <meta property="og:site_name" content="Barbara Broadnax">

  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="Barbara Broadnax | Product & Design">
  <meta name="twitter:description" content="Senior Product Designer shipping work across legal tech, aviation, and e-commerce. Case studies on accessibility and design that performs.">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --white:  #ffffff;
      --ink:    #150d26;
      --purple: #2d0a5e;
      --muted:  #7c6d90;
      --rule:   rgba(21, 13, 38, 0.1);
      --pad:    clamp(1.25rem, 5vw, 4rem);
    }

    html { font-size: 16px; scroll-behavior: smooth; }

    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: var(--white);
      color: var(--ink);
      -webkit-font-smoothing: antialiased;
      overflow-x: hidden;
    }

    a { text-decoration: none; color: inherit; }
    img { display: block; max-width: 100%; }

    .scroll-progress {
      position: fixed; top: 56px; left: 0; height: 2px; width: 0%;
      background: var(--purple); z-index: 101; pointer-events: none;
    }

    nav {
      position: sticky; top: 0; z-index: 100;
      background: var(--white); border-bottom: 1px solid var(--rule);
      height: 56px; display: flex; align-items: center; justify-content: space-between;
      padding: 0 var(--pad); gap: 2rem;
    }
    nav > * { opacity: 0; transform: translateY(-6px); animation: navIn 0.5s ease forwards; }
    nav > *:nth-child(1) { animation-delay: 0s; }
    nav > *:nth-child(2) { animation-delay: 0.06s; }
    nav > *:nth-child(3) { animation-delay: 0.12s; }
    nav > *:nth-child(4) { animation-delay: 0.18s; }
    @keyframes navIn { to { opacity: 1; transform: translateY(0); } }

    .site-name { display: flex; flex-direction: column; gap: 1px; line-height: 1; flex-shrink: 0; text-decoration: none; }
    .site-name .name-first { display: block; font-size: 0.6rem; font-weight: 800; letter-spacing: 0.24em; text-transform: uppercase; color: var(--ink); }
    .site-name .name-last { display: block; font-size: 0.6rem; font-weight: 800; letter-spacing: 0.155em; text-transform: uppercase; color: var(--ink); }

    .nav-divider { width: 1px; height: 22px; background: var(--rule); flex-shrink: 0; }

    .ticker { display: flex; align-items: center; gap: 0.45rem; flex: 1; }
    .ticker-label { font-size: 0.7rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink); white-space: nowrap; line-height: 1; }
    .ticker-track { position: relative; height: 1em; overflow: hidden; min-width: 210px; }
    .ticker-word { position: absolute; inset: 0; display: flex; align-items: center; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--purple); white-space: nowrap; opacity: 0; transform: translateY(110%); line-height: 1; }
    .ticker-word.is-in  { animation: wordIn  0.4s cubic-bezier(0.16,1,0.3,1) forwards; }
    .ticker-word.is-out { animation: wordOut 0.3s ease-in forwards; }
    @keyframes wordIn  { from{opacity:0;transform:translateY(110%)} to{opacity:1;transform:translateY(0)} }
    @keyframes wordOut { from{opacity:1;transform:translateY(0)} to{opacity:0;transform:translateY(-110%)} }

    .nav-links { display: flex; gap: 2rem; list-style: none; flex-shrink: 0; }
    .nav-links a { font-size: 0.68rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); transition: color 0.2s; }
    .nav-links a:hover { color: var(--purple); }
    .nav-links a:focus-visible { outline: 2px solid var(--purple); outline-offset: 3px; border-radius: 2px; }

    .thesis { padding: 5rem var(--pad) 4.5rem; }
    .thesis-line { display: block; font-size: clamp(1.6rem, 3.5vw, 2.4rem); font-weight: 700; letter-spacing: -0.03em; line-height: 1.3; color: var(--ink); overflow: hidden; }
    .thesis-line-inner { display: block; transform: translateY(105%); opacity: 0; transition: transform 0.9s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.7s ease; }
    .thesis-line-inner.visible { transform: translateY(0); opacity: 1; }
    .thesis-line-inner em { font-style: normal; color: var(--purple); }

    .asterisk-trigger { color: var(--purple); cursor: pointer; font-size: 0.5em; font-weight: 800; vertical-align: super; line-height: 0; user-select: none; transition: color 0.15s; }
    .asterisk-trigger:hover { color: var(--ink); }
    .asterisk-trigger:focus-visible { outline: 2px solid var(--purple); outline-offset: 2px; border-radius: 2px; }

    .asterisk-tooltip { position: fixed; background: var(--ink); color: #f0edf7; font-size: 0.82rem; font-weight: 400; font-family: 'Inter', sans-serif; letter-spacing: 0; text-transform: none; line-height: 1.65; padding: 0.9rem 1.1rem; border-radius: 10px; width: 268px; max-width: calc(100vw - 2rem); z-index: 1000; box-shadow: 0 8px 32px rgba(21, 13, 38, 0.18); opacity: 0; transform: translateY(-5px) scale(0.96); pointer-events: none; transition: opacity 0.22s ease, transform 0.22s cubic-bezier(0.16,1,0.3,1); }
    .asterisk-tooltip.visible { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
    .asterisk-tooltip::before { content: ''; position: absolute; top: -5px; left: 16px; width: 10px; height: 5px; background: var(--ink); clip-path: polygon(50% 0%, 0% 100%, 100% 100%); }

    .co-section { padding: 0 var(--pad) 3rem; }
    .co-eyebrow { font-size: 0.62rem; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted); margin-bottom: 2rem; opacity: 0; transform: translateY(8px); transition: opacity 0.5s ease, transform 0.5s ease; }
    .co-eyebrow.visible { opacity: 1; transform: none; }

    .co-row { display: grid; grid-template-columns: 2.5rem 1fr 1.6fr; align-items: start; gap: 0 2.5rem; padding: 1.75rem 0; border-bottom: 1px solid var(--rule); clip-path: inset(0 100% 0 0); opacity: 0; transition: clip-path 0.75s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.05s linear; }
    .co-row:first-of-type { border-top: 1px solid var(--rule); }
    .co-row.visible { clip-path: inset(0 0% 0 0); opacity: 1; }
    .co-index { font-size: 0.62rem; font-weight: 700; letter-spacing: 0.08em; color: var(--muted); padding-top: 0.25rem; }
    .co-name { font-size: clamp(1.2rem, 2.5vw, 1.75rem); font-weight: 800; letter-spacing: -0.03em; color: var(--ink); text-transform: uppercase; line-height: 1.1; }
    .co-right { display: flex; flex-direction: column; gap: 0.45rem; }
    .co-industry { font-size: 0.62rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--purple); }
    .co-desc { font-size: 0.88rem; color: var(--muted); line-height: 1.7; max-width: 460px; }
    @media (max-width: 640px) { .co-row { grid-template-columns: 1fr; gap: 0.5rem 0; } .co-index { display: none; } }

    .work-record { padding: 0 var(--pad); border-top: 1px solid var(--rule); }
    .record-header { display: grid; grid-template-columns: 20% 1fr 22% 24%; padding: 0.75rem 0; border-bottom: 1px solid var(--rule); opacity: 0; transform: translateY(6px); transition: opacity 0.5s ease, transform 0.5s ease; }
    .record-header.visible { opacity: 1; transform: none; }
    .record-header span { font-size: 0.6rem; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted); }

    .record-row { display: grid; grid-template-columns: 20% 1fr 22% 24%; align-items: center; margin: 0 calc(-1 * var(--pad)); padding: 1.5rem var(--pad); position: relative; cursor: pointer; color: inherit; text-decoration: none; transition: background 0.25s ease; }
    .record-row:hover { background: rgba(45, 10, 94, 0.025); }
    .record-row:focus-visible { outline: 2px solid var(--purple); outline-offset: -2px; }
    .record-row .record-arrow { position: absolute; right: var(--pad); top: 50%; translate: 4px -50%; opacity: 0; font-size: 0.75rem; color: var(--purple); transition: opacity 0.2s ease, translate 0.25s cubic-bezier(0.16,1,0.3,1); pointer-events: none; }
    .record-row:hover .record-arrow { opacity: 1; translate: 0 -50%; }
    .record-row::after { content: ''; position: absolute; bottom: 0; left: var(--pad); right: var(--pad); height: 1px; width: 0; background: var(--rule); transition: width 0.55s cubic-bezier(0.16, 1, 0.3, 1); }
    .record-row.visible::after { width: calc(100% - var(--pad) * 2); }
    .record-row > span { opacity: 0; transform: translateY(10px); transition: opacity 0.4s ease, transform 0.4s ease; }
    .record-row.visible > span:nth-child(1) { opacity:1; transform:none; transition-delay:0.18s; }
    .record-row.visible > span:nth-child(2) { opacity:1; transform:none; transition-delay:0.26s; }
    .record-row.visible > span:nth-child(3) { opacity:1; transform:none; transition-delay:0.34s; }
    .record-row.visible > span:nth-child(4) { opacity:1; transform:none; transition-delay:0.42s; }
    .record-row.visible .record-arrow { transition-delay: 0s; }

    .record-company { font-size: 0.65rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--purple); }
    .record-project { font-size: 0.95rem; font-weight: 700; color: var(--ink); letter-spacing: -0.01em; }
    .record-role { font-size: 0.78rem; font-weight: 400; color: var(--muted); }
    .record-outcome { font-size: 0.78rem; font-weight: 600; color: var(--ink); }

    .interstitial { padding: 5rem 0; max-width: 720px; }
    .interstitial p { font-size: clamp(1rem, 1.5vw, 1.15rem); font-weight: 400; line-height: 1.8; color: var(--muted); max-width: none; }
    .interstitial p strong { color: var(--ink); font-weight: 600; }
    .reveal-word { display: inline-block; opacity: 0; transform: translateY(12px); filter: blur(4px); transition: opacity 0.35s ease, transform 0.35s ease, filter 0.35s ease; }
    .reveal-word.visible { opacity: 1; transform: translateY(0); filter: blur(0); }

    .side-projects { background: #212121; padding-bottom: 5rem; }
    .sp-intro { padding: 5rem var(--pad) 3rem; opacity: 0; transform: translateY(16px); transition: opacity 0.7s ease, transform 0.7s cubic-bezier(0.16,1,0.3,1); }
    .sp-intro.visible { opacity: 1; transform: none; }
    .section-eyebrow { font-size: 0.62rem; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: #c084fc; margin-bottom: 1.25rem; }
    .sp-headline { font-size: clamp(1.6rem, 3.5vw, 2.6rem); font-weight: 800; letter-spacing: -0.03em; color: #f0edf7; line-height: 1.15; margin-bottom: 1rem; }
    .sp-lead { font-size: clamp(0.9rem, 1.4vw, 1.05rem); color: rgba(240, 237, 247, 0.5); line-height: 1.8; max-width: 580px; }

    .sp-carousel-wrap { position: relative; }
    .sp-carousel { display: flex; gap: 1.25rem; overflow-x: auto; scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; padding: 0 var(--pad) 2rem; scrollbar-width: none; }
    .sp-carousel::-webkit-scrollbar { display: none; }

    .sp-card { display: flex; flex-direction: column; justify-content: space-between; gap: 2.5rem; background: #2c2c2c; color: #f0edf7; padding: 2.5rem; position: relative; overflow: hidden; text-decoration: none; border: 1px solid rgba(255,255,255,0.07); border-radius: 2px; flex-shrink: 0; width: clamp(300px, 38vw, 440px); min-height: 460px; scroll-snap-align: start; opacity: 0; translate: 0 32px; transition: border-color 0.3s, box-shadow 0.3s, transform 0.3s cubic-bezier(0.16,1,0.3,1); }
    .sp-card.visible { opacity: 1; translate: 0 0; transition: translate 0.65s cubic-bezier(0.16,1,0.3,1), opacity 0.65s ease, border-color 0.3s, box-shadow 0.3s, transform 0.3s cubic-bezier(0.16,1,0.3,1); }
    .sp-card:hover { border-color: rgba(192, 132, 252, 0.25); box-shadow: 0 24px 60px rgba(0, 0, 0, 0.4); transform: scale(1.012); }
    .sp-glare { position: absolute; inset: 0; background: radial-gradient(500px circle at var(--gx, 50%) var(--gy, 50%), rgba(192, 132, 252, 0.08), transparent 50%); opacity: 0; transition: opacity 0.4s; pointer-events: none; z-index: 0; }
    .sp-card:hover .sp-glare { opacity: 1; }
    .sp-card-top { position: relative; z-index: 1; }
    .sp-meta { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; }
    .sp-live { display: flex; align-items: center; gap: 0.4rem; font-size: 0.6rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(192, 132, 252, 1); }
    .sp-dot { width: 6px; height: 6px; border-radius: 50%; background: #c084fc; flex-shrink: 0; animation: livePulse 2.2s ease-in-out infinite; }
    @keyframes livePulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.75); } }
    .sp-type { font-size: 0.6rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(240, 237, 247, 0.35); }
    .sp-title { font-size: clamp(2rem, 5vw, 3.5rem); font-weight: 800; letter-spacing: -0.04em; color: #f0edf7; line-height: 1; text-transform: uppercase; }
    .sp-card-bottom { display: flex; flex-direction: column; gap: 1.25rem; position: relative; z-index: 1; }
    .sp-desc { font-size: 0.88rem; color: rgba(240, 237, 247, 0.6); line-height: 1.75; max-width: 560px; }
    .sp-desc strong { color: rgba(240, 237, 247, 0.9); font-weight: 600; }
    .sp-tags { display: flex; flex-wrap: wrap; gap: 0.5rem; }
    .sp-tag { font-size: 0.58rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(240, 237, 247, 0.4); border: 1px solid rgba(240, 237, 247, 0.12); padding: 0.3rem 0.75rem; border-radius: 100px; }
    .sp-cta { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #c084fc; transition: gap 0.25s; align-self: flex-start; }
    .sp-card:hover .sp-cta { gap: 0.75rem; }

    .sp-quote-wrap { padding: 3rem var(--pad) 0; }
    .sp-rule { border: none; border-top: 1px solid rgba(255, 255, 255, 0.1); margin-bottom: 2.5rem; }
    .sp-quote { font-size: clamp(1.25rem, 2.4vw, 1.75rem); font-style: italic; font-weight: 500; color: rgba(240, 237, 247, 0.45); line-height: 1.5; letter-spacing: -0.02em; max-width: 780px; }
    .sp-quote cite { font-style: normal; font-weight: 600; color: rgba(240, 237, 247, 0.22); display: block; margin-top: 1rem; font-size: 0.75rem; letter-spacing: 0.1em; text-transform: uppercase; }

    footer { border-top: 1px solid var(--rule); padding: 2rem var(--pad); display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
    footer p { font-size: 0.72rem; color: var(--muted); }
    .footer-links { display: flex; gap: 1.5rem; list-style: none; }
    .footer-links a { font-size: 0.72rem; color: var(--purple); transition: color 0.2s; }
    .footer-links a:hover { color: var(--ink); }

    @media (max-width: 860px) {
      .record-header { display: none; }
      .record-row { grid-template-columns: 1fr auto; grid-template-rows: auto auto; gap: 0.2rem 0; }
      .record-company { grid-column:1; grid-row:1; }
      .record-project { grid-column:1/-1; grid-row:2; font-size:0.88rem; }
      .record-role { display:none; }
      .record-outcome { grid-column:2; grid-row:1; text-align:right; font-size:0.72rem; }
    }
    @media (max-width: 560px) { .nav-links { display:none; } }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }
      .thesis-line-inner, .record-row > span, .reveal-word, .section-eyebrow, .sp-card { opacity: 1 !important; transform: none !important; translate: none !important; filter: none !important; }
      .record-row::after { width: 100% !important; }
      .scroll-progress { display: none; }
    }
  </style>
</head>
<body>

  <div class="scroll-progress" id="scrollProgress"></div>

${navHtml(d.tickerLabel)}

  <div class="thesis">
    <span class="thesis-line">
      <span class="thesis-line-inner">${htmlEscape(d.thesis1)}<sup class="asterisk-trigger" id="asteriskTrigger" tabindex="0" role="button" aria-label="Footnote about shipped products">*</sup></span>
    </span>
    <span class="thesis-line">
      <span class="thesis-line-inner"><em>${htmlEscape(d.thesis2)}</em></span>
    </span>
  </div>

  <div class="asterisk-tooltip" id="asteriskTooltip" role="tooltip">
    ${htmlEscape(d.asterisk)}
  </div>

  <div class="co-section">
    <p class="co-eyebrow" id="coEyebrow">${htmlEscape(d.coEyebrow)}</p>
${companyHtml}
  </div>

  <div class="work-record" id="work">
    <div class="record-header" id="recordHeader">
      ${headerCells}
    </div>

${d.workRowsHtml}
  </div>

  <div class="side-projects">

    <div class="sp-intro" id="spIntro">
      <p class="section-eyebrow">${htmlEscape(d.spEyebrow)}</p>
      <h2 class="sp-headline">${htmlEscape(d.spHeadline)}</h2>
      <p class="sp-lead">${htmlEscape(d.spLead)}</p>
    </div>

    <div class="sp-carousel-wrap">
      <div class="sp-carousel" id="spCarousel">
        <a href="https://www.mtrcd.com/wcag" target="_blank" rel="noopener" class="sp-card" id="spCard">
          <div class="sp-glare" id="spGlare"></div>
          <div class="sp-card-top">
            <div class="sp-meta">
              <span class="sp-live"><span class="sp-dot"></span>Live</span>
              <span class="sp-type">AI Project</span>
            </div>
            <h2 class="sp-title">MTRCD<br>WCAG Guide</h2>
          </div>
          <div class="sp-card-bottom">
            <p class="sp-desc"><strong>This is a product design exercise, not a prompt exercise.</strong> Every feature is a decision: what to build, how to structure it, what to cut. I shape the vision and the architecture. The AI handles execution. Consistently updated with audit tools, plain-language resources, and code examples for all 56 WCAG 2.2 criteria.</p>
            <div class="sp-tags">
              <span class="sp-tag">WCAG 2.2</span>
              <span class="sp-tag">Accessibility</span>
              <span class="sp-tag">AI-assisted</span>
              <span class="sp-tag">Design tools</span>
            </div>
            <span class="sp-cta">View project &rarr;</span>
          </div>
        </a>
      </div>
    </div>

    <div class="sp-quote-wrap">
      <hr class="sp-rule">
      <blockquote class="sp-quote">
        ${htmlEscape(d.spQuote)}
        <cite>${htmlEscape(d.spCite)}</cite>
      </blockquote>
    </div>

  </div>

${footerHtml(d.footerEmail, d.footerLinkedIn)}

  <script>
    const progressBar = document.getElementById('scrollProgress');
    function updateProgress() {
      const h = document.documentElement.scrollHeight - window.innerHeight;
      if (h <= 0) return;
      progressBar.style.width = ((window.scrollY / h) * 100) + '%';
    }
    window.addEventListener('scroll', updateProgress, { passive: true });

${tickerScript(d.tickerPhrases)}

    const thesisLines = document.querySelectorAll('.thesis-line-inner');
    thesisLines.forEach((line, i) => { setTimeout(() => line.classList.add('visible'), 250 + i * 200); });

    const asteriskTrigger = document.getElementById('asteriskTrigger');
    const asteriskTooltip = document.getElementById('asteriskTooltip');
    let dismissTimer;
    function positionTooltip() {
      const rect = asteriskTrigger.getBoundingClientRect();
      const tooltipW = 268;
      let left = rect.left - 10;
      if (left + tooltipW > window.innerWidth - 16) left = window.innerWidth - tooltipW - 16;
      asteriskTooltip.style.top  = (rect.bottom + 10) + 'px';
      asteriskTooltip.style.left = Math.max(16, left) + 'px';
    }
    function toggleTooltip(e) {
      e.stopPropagation();
      const showing = asteriskTooltip.classList.contains('visible');
      clearTimeout(dismissTimer);
      if (showing) {
        asteriskTooltip.classList.remove('visible');
      } else {
        positionTooltip();
        asteriskTooltip.classList.add('visible');
        dismissTimer = setTimeout(() => asteriskTooltip.classList.remove('visible'), 5000);
      }
    }
    if (asteriskTrigger) {
      asteriskTrigger.addEventListener('click', toggleTooltip);
      asteriskTrigger.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTooltip(e); } });
      document.addEventListener('click', () => { asteriskTooltip.classList.remove('visible'); clearTimeout(dismissTimer); });
    }

    function buildWordSpans(el) {
      if (!el) return;
      const nodes = el.childNodes;
      let html = '';
      nodes.forEach(node => {
        if (node.nodeType === 3) {
          node.textContent.split(/(\\s+)/).forEach(part => {
            if (part.trim()) html += '<span class="reveal-word">' + part + '</span> ';
            else if (part) html += part;
          });
        } else if (node.nodeName === 'STRONG') {
          node.textContent.split(/(\\s+)/).forEach(part => {
            if (part.trim()) html += '<strong class="reveal-word">' + part + '</strong> ';
            else if (part) html += part;
          });
        } else {
          html += node.outerHTML || node.textContent;
        }
      });
      el.innerHTML = html;
    }
    const interstitialP  = document.getElementById('interstitial-text');
    const interstitialP2 = document.getElementById('interstitial-text-2');
    if (interstitialP)  buildWordSpans(interstitialP);
    if (interstitialP2) buildWordSpans(interstitialP2);

    const coEyebrow = document.getElementById('coEyebrow');
    const coRows    = document.querySelectorAll('.co-row');
    if (coEyebrow) {
      const coObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            coEyebrow.classList.add('visible');
            coRows.forEach((row, i) => { setTimeout(() => row.classList.add('visible'), i * 140); });
            coObserver.disconnect();
          }
        });
      }, { threshold: 0.2 });
      coObserver.observe(coEyebrow);
    }

    const rows      = document.querySelectorAll('.record-row');
    const recHeader = document.getElementById('recordHeader');
    const words     = interstitialP  ? interstitialP.querySelectorAll('.reveal-word')  : [];
    const words2    = interstitialP2 ? interstitialP2.querySelectorAll('.reveal-word') : [];
    const spIntro   = document.getElementById('spIntro');
    const spCard    = document.getElementById('spCard');

    const rowObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) { entry.target.classList.add('visible'); rowObserver.unobserve(entry.target); }
      });
    }, { threshold: 0.15 });
    if (recHeader) rowObserver.observe(recHeader);
    rows.forEach(row => rowObserver.observe(row));

    if (interstitialP) {
      const wordObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            words.forEach((w, i) => setTimeout(() => w.classList.add('visible'), i * 30));
            const p2Delay = words.length * 30 + 150;
            words2.forEach((w, i) => setTimeout(() => w.classList.add('visible'), p2Delay + i * 30));
            wordObserver.unobserve(entry.target);
          }
        });
      }, { threshold: 0.25 });
      wordObserver.observe(interstitialP);
    }

    const genObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) { entry.target.classList.add('visible'); genObserver.unobserve(entry.target); }
      });
    }, { threshold: 0.1 });
    if (spIntro) genObserver.observe(spIntro);
    if (spCard)  genObserver.observe(spCard);

    const spGlare = document.getElementById('spGlare');
    if (spCard && spGlare) {
      spCard.addEventListener('mousemove', (e) => {
        const rect = spCard.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top)  / rect.height;
        spGlare.style.setProperty('--gx', (x * 100) + '%');
        spGlare.style.setProperty('--gy', (y * 100) + '%');
      });
    }
  </script>

</body>
</html>`;
}

// ─── case study template ─────────────────────────────────────────────────

interface CaseData {
  title: string;
  company: string;
  subtitle: string;
  about_html: string;
  meta: MetaItem[];
  body_html: string;
  prev: CaseStudyRow | null;
  next: CaseStudyRow | null;
  tickerPhrases: string[];
  tickerLabel: string;
  footerEmail: string;
  footerLinkedIn: string;
}

function caseStudyTemplate(d: CaseData): string {
  const metaHtml = d.meta.map((m) => `        <div class="case-meta-item">
          <p class="label">${htmlEscape(m.label)}</p>
          <p>${htmlEscape(m.value)}</p>
        </div>`).join('\n');

  const aboutBlock = d.about_html ? `      <div class="company-context">
        ${d.about_html}
      </div>
` : '';

  const subtitleBlock = d.subtitle
    ? `      <p class="animate-in delay-2" style="font-size: 1.15rem; max-width: 640px;">${htmlEscape(d.subtitle)}</p>\n`
    : '';

  const navBlock = (d.prev || d.next) ? `  <div class="container">
    <div class="case-nav">
      ${d.prev ? `<a href="/work/${attrEscape(d.prev.id)}">
        <span class="label">&larr; Previous</span>
        <span>${htmlEscape(d.prev.title)}</span>
      </a>` : '<span></span>'}
      ${d.next ? `<a href="/work/${attrEscape(d.next.id)}" class="next">
        <span class="label">Next &rarr;</span>
        <span>${htmlEscape(d.next.title)}</span>
      </a>` : '<span></span>'}
    </div>
  </div>
` : '';

  const titleEsc = htmlEscape(`${d.title} — ${d.company} | Barbara Broadnax`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${titleEsc}</title>
  <meta name="description" content="${attrEscape(d.subtitle)}">

  <meta property="og:type" content="article">
  <meta property="og:title" content="${titleEsc}">
  <meta property="og:description" content="${attrEscape(d.subtitle)}">
  <meta property="og:site_name" content="Barbara Broadnax">

  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${titleEsc}">
  <meta name="twitter:description" content="${attrEscape(d.subtitle)}">

  <!-- Resolve any relative URLs in body_html (images/foo.png) from the site root,
       since the case study URL is /work/:slug now (was /:slug.html before). -->
  <base href="/">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>

${navHtml(d.tickerLabel)}

  <section class="case-hero">
    <div class="container">
      <p class="label animate-in">${htmlEscape(d.company)}</p>
      <h1 class="animate-in delay-1">${htmlEscape(d.title)}</h1>
${subtitleBlock}${aboutBlock}      <div class="case-meta animate-in delay-3">
${metaHtml}
      </div>
    </div>
  </section>

  ${d.body_html}

${navBlock}${footerHtml(d.footerEmail, d.footerLinkedIn)}

  <script>
${tickerScript(d.tickerPhrases)}
  </script>
</body>
</html>`;
}

// ─── 404 + health ────────────────────────────────────────────────────────

function notFound(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Not found · Barbara Broadnax</title>
  <style>
    body { font-family: 'Inter', -apple-system, sans-serif; background: #ffffff; color: #150d26; min-height: 100vh; display: grid; place-items: center; margin: 0; padding: 2rem; text-align: center; }
    a { color: #2d0a5e; }
  </style>
</head>
<body>
  <div>
    <h1 style="font-size: 1.5rem; font-weight: 700; margin-bottom: 0.75rem;">Not found</h1>
    <p style="color: #7c6d90;">That page doesn't exist. <a href="/">Go home</a>.</p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

async function serveUpload(env: Env, key: string, headOnly: boolean): Promise<Response> {
  if (!key || key.includes('..')) return notFound();
  const obj = await env.PUBLIC_BUCKET.get(key);
  if (!obj) return notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=86400, immutable');
  headers.set('ETag', obj.httpEtag);
  return new Response(headOnly ? null : obj.body, { status: 200, headers });
}

async function handleHealth(env: Env): Promise<Response> {
  try {
    const row = await env.DB.prepare(
      'SELECT key FROM site_content WHERE key = ? LIMIT 1'
    ).bind('ticker_phrases').first<{ key: string }>();

    const cs = await env.DB.prepare(
      'SELECT count(*) as n FROM case_studies WHERE status = ?'
    ).bind('published').first<{ n: number }>();

    let shareLinks: number | string = 'pending';
    try {
      const sl = await env.DB.prepare('SELECT count(*) as n FROM share_links').first<{ n: number }>();
      shareLinks = sl?.n ?? 0;
    } catch { /* migration not applied */ }

    return Response.json({
      ok: true,
      db: row?.key ? 'connected-with-data' : 'connected-empty',
      published_case_studies: cs?.n ?? 0,
      share_links: shareLinks,
      worker: 'broadnaxux-public',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

// ─── share-links: data ───────────────────────────────────────────────────

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
  // Added in migration 0006. JSON object: { "<case_study_id>": "<version_id>" }
  case_study_versions: string | null;
}

async function loadShareLinkByToken(env: Env, token: string): Promise<ShareLinkRow | null> {
  // Try the v0006 columns first; if migration hasn't been applied yet,
  // fall back to the v0003 column set so existing share-links keep working.
  try {
    return await env.DB.prepare(
      `SELECT id, token, name, recipient_label, case_study_ids, resume_file_key,
              resume_file_name, custom_headline, custom_message, password_hash,
              created_at, expires_at, case_study_versions
         FROM share_links WHERE token = ?`
    ).bind(token).first<ShareLinkRow>();
  } catch {
    const fallback = await env.DB.prepare(
      `SELECT id, token, name, recipient_label, case_study_ids, resume_file_key,
              resume_file_name, custom_headline, custom_message, password_hash,
              created_at, expires_at
         FROM share_links WHERE token = ?`
    ).bind(token).first<Omit<ShareLinkRow, 'case_study_versions'>>();
    return fallback ? { ...fallback, case_study_versions: null } : null;
  }
}

function parseVersionMap(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' && VERSION_ID_RE.test(v)) out[k] = v;
      }
      return out;
    }
  } catch { /* fall through */ }
  return {};
}

async function resolveShortLink(env: Env, slug: string): Promise<Response> {
  // The slug column was added in migration 0005. If the migration hasn't
  // been applied yet, the SELECT will throw — fall through to a 404 rather
  // than 500, since the alias simply isn't resolvable.
  let row: { token: string } | null = null;
  try {
    row = await env.DB.prepare(`SELECT token FROM share_links WHERE slug = ? LIMIT 1`)
      .bind(slug).first<{ token: string }>();
  } catch { /* migration not applied */ }
  if (!row) {
    return new Response('Short link not found.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' },
    });
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: `/share/${row.token}`,
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'private, no-store',
    },
  });
}

async function loadCaseStudiesByIds(env: Env, ids: string[]): Promise<CaseStudyRow[]> {
  if (ids.length === 0) return [];
  // Filter to known IDs and preserve the requested order. Limit list so D1
  // SQL stays small even if someone tampered with the JSON.
  const safe = ids.filter((id) => SLUG_RE.test(id)).slice(0, 32);
  if (safe.length === 0) return [];
  const placeholders = safe.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id, title, company, role, outcome_metric, hero_image_key, body_html,
            status, sort_order, subtitle, about_html, meta_items,
            meta_role, meta_team, meta_rating
       FROM case_studies WHERE id IN (${placeholders})`
  ).bind(...safe).all<CaseStudyRow>();
  const byId = new Map((results ?? []).map((r) => [r.id, r]));
  return safe.map((id) => byId.get(id)).filter((r): r is CaseStudyRow => Boolean(r));
}

// ─── share-links: cookies + password verification ────────────────────────

const SHARE_COOKIE_PREFIX = 'sl_unlock_';
const SHARE_TRACK_COOKIE_PREFIX = 'sl_seen_'; // dedup landing-page open events per browser

function shareCookie(token: string): string { return SHARE_COOKIE_PREFIX + token; }
function shareSeenCookie(token: string): string { return SHARE_TRACK_COOKIE_PREFIX + token; }

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

async function deriveUnlockCookieValue(token: string, passwordHash: string): Promise<string> {
  // Stateless: cookie value = base64url(SHA-256(token + ':' + password_hash)).
  // Tied to the current password — rotating password invalidates old cookies.
  const data = new TextEncoder().encode(`${token}:${passwordHash}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return bytesToBase64Url(digest);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
  if (derived.byteLength !== expected.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < derived.byteLength; i++) diff |= derived[i] ^ expected[i];
  return diff === 0;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function isUnlocked(request: Request, link: ShareLinkRow): Promise<boolean> {
  if (!link.password_hash) return true;
  const cookies = parseCookies(request.headers.get('Cookie') ?? '');
  const cookie = cookies[shareCookie(link.token)];
  if (!cookie) return false;
  const expected = await deriveUnlockCookieValue(link.token, link.password_hash);
  return constantTimeEqual(cookie, expected);
}

// ─── share-links: tracking ───────────────────────────────────────────────

async function hashIp(request: Request): Promise<string> {
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  if (!ip) return '';
  const data = new TextEncoder().encode(`broadnaxux-share:${ip}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  // Truncate — we only need this for rough dedup
  return bytesToBase64Url(digest).slice(0, 22);
}

async function recordView(env: Env, request: Request, linkId: string, event: 'open' | 'unlock_failed' | 'card_click' | 'resume_download', caseStudyId: string | null = null): Promise<void> {
  try {
    const ipHash = await hashIp(request);
    const ua = (request.headers.get('User-Agent') ?? '').slice(0, 300);
    const ref = (request.headers.get('Referer') ?? '').slice(0, 300);
    await env.DB.prepare(
      `INSERT INTO share_link_views (share_link_id, viewed_at, event, case_study_id, ip_hash, user_agent, referrer)
       VALUES (?, unixepoch(), ?, ?, ?, ?, ?)`
    ).bind(linkId, event, caseStudyId, ipHash || null, ua || null, ref || null).run();
    if (event === 'open') {
      await env.DB.prepare(`UPDATE share_links SET last_viewed_at = unixepoch() WHERE id = ?`).bind(linkId).run();
    }
  } catch {
    // Never fail the request because of tracking.
  }
}

// ─── share-links: handlers ───────────────────────────────────────────────

async function renderShareLink(env: Env, request: Request, token: string, headOnly: boolean): Promise<Response> {
  let link: ShareLinkRow | null = null;
  try {
    link = await loadShareLinkByToken(env, token);
  } catch {
    return shareNotFound();
  }
  if (!link) return shareNotFound();

  const now = Math.floor(Date.now() / 1000);
  if (link.expires_at && link.expires_at < now) {
    return shareExpiredPage();
  }

  // Password gate
  const unlocked = await isUnlocked(request, link);
  if (!unlocked) {
    return new Response(headOnly ? null : sharePasswordPage(token, link), {
      status: 200,
      headers: shareHeaders('text/html; charset=utf-8'),
    });
  }

  // Load curated case studies in order
  const ids = parseCaseStudyIds(link.case_study_ids);
  const caseStudies = await loadCaseStudiesByIds(env, ids);

  // Track open (dedup per browser via simple cookie that lasts the session)
  const cookies = parseCookies(request.headers.get('Cookie') ?? '');
  const seen = cookies[shareSeenCookie(token)];
  const setCookies: string[] = [];
  if (!seen) {
    await recordView(env, request, link.id, 'open');
    setCookies.push(`${shareSeenCookie(token)}=1; HttpOnly; Secure; SameSite=Strict; Path=/share/${token}; Max-Age=86400`);
  }

  const versionMap = parseVersionMap(link.case_study_versions);
  const html = shareLandingPage({ link, caseStudies, versionMap });
  const headers = shareHeaders('text/html; charset=utf-8');
  for (const c of setCookies) headers.append('Set-Cookie', c);
  return new Response(headOnly ? null : html, { status: 200, headers });
}

async function handleShareUnlock(env: Env, request: Request, token: string): Promise<Response> {
  const link = await loadShareLinkByToken(env, token).catch(() => null);
  if (!link) return shareNotFound();
  if (link.expires_at && link.expires_at < Math.floor(Date.now() / 1000)) return shareExpiredPage();
  if (!link.password_hash) {
    // No password configured; just redirect back
    return new Response(null, { status: 303, headers: { Location: `/share/${token}` } });
  }

  const form = await request.formData().catch(() => null);
  const password = String(form?.get('password') ?? '');
  const ok = password ? await verifyPassword(password, link.password_hash) : false;

  if (!ok) {
    await recordView(env, request, link.id, 'unlock_failed');
    return new Response(sharePasswordPage(token, link, true), {
      status: 401,
      headers: shareHeaders('text/html; charset=utf-8'),
    });
  }

  const cookieValue = await deriveUnlockCookieValue(token, link.password_hash);
  const headers = shareHeaders('text/html; charset=utf-8');
  // 30-day cookie scoped to /share/:token
  headers.append('Set-Cookie', `${shareCookie(token)}=${cookieValue}; HttpOnly; Secure; SameSite=Strict; Path=/share/${token}; Max-Age=2592000`);
  headers.set('Location', `/share/${token}`);
  return new Response(null, { status: 303, headers });
}

async function serveShareResume(env: Env, request: Request, token: string, headOnly: boolean): Promise<Response> {
  const link = await loadShareLinkByToken(env, token).catch(() => null);
  if (!link) return shareNotFound();
  if (link.expires_at && link.expires_at < Math.floor(Date.now() / 1000)) return shareExpiredPage();
  if (!await isUnlocked(request, link)) return new Response('Unauthorized', { status: 401 });
  if (!link.resume_file_key) return shareNotFound();

  const obj = await env.PRIVATE_BUCKET.get(link.resume_file_key);
  if (!obj) return shareNotFound();

  await recordView(env, request, link.id, 'resume_download');

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Content-Type', 'application/pdf');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  const filename = link.resume_file_name || 'resume.pdf';
  // inline so browsers preview rather than force download
  headers.set('Content-Disposition', `inline; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  return new Response(headOnly ? null : obj.body, { status: 200, headers });
}

async function handleShareTrack(env: Env, request: Request, token: string): Promise<Response> {
  const link = await loadShareLinkByToken(env, token).catch(() => null);
  if (!link) return new Response(null, { status: 204 });
  if (!await isUnlocked(request, link)) return new Response(null, { status: 204 });

  let payload: { event?: string; case_study_id?: string } = {};
  try {
    const body = await request.text();
    if (body) payload = JSON.parse(body);
  } catch { /* swallow */ }

  const event = payload.event === 'card_click' ? 'card_click' : null;
  const caseStudyId = typeof payload.case_study_id === 'string' && SLUG_RE.test(payload.case_study_id) ? payload.case_study_id : null;
  if (event && caseStudyId) {
    await recordView(env, request, link.id, event, caseStudyId);
  }
  return new Response(null, { status: 204 });
}

function parseCaseStudyIds(s: string): string[] {
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed.filter((x: unknown): x is string => typeof x === 'string');
  } catch { /* empty */ }
  return [];
}

function shareHeaders(contentType: string): Headers {
  const h = new Headers();
  h.set('Content-Type', contentType);
  h.set('X-Robots-Tag', 'noindex, nofollow');
  // Don't cache share-links anywhere
  h.set('Cache-Control', 'private, no-store');
  return h;
}

function shareNotFound(): Response {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Link not found · Barbara Broadnax</title>
<meta name="robots" content="noindex,nofollow">
<style>body{font-family:'Inter',-apple-system,sans-serif;background:#fff;color:#150d26;min-height:100vh;display:grid;place-items:center;margin:0;padding:2rem;text-align:center;}a{color:#2d0a5e;}</style></head>
<body><div><h1 style="font-size:1.4rem;font-weight:700;margin-bottom:0.6rem;">This link doesn't exist</h1>
<p style="color:#7c6d90;">The URL may be wrong or the link may have been deleted.<br><a href="/">Visit barbarabroadnax.com</a>.</p></div></body></html>`;
  return new Response(html, { status: 404, headers: shareHeaders('text/html; charset=utf-8') });
}

function shareExpiredPage(): Response {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Link expired · Barbara Broadnax</title>
<meta name="robots" content="noindex,nofollow">
<style>body{font-family:'Inter',-apple-system,sans-serif;background:#fff;color:#150d26;min-height:100vh;display:grid;place-items:center;margin:0;padding:2rem;text-align:center;}a{color:#2d0a5e;}</style></head>
<body><div><h1 style="font-size:1.4rem;font-weight:700;margin-bottom:0.6rem;">This link has expired</h1>
<p style="color:#7c6d90;">Reach out and I'll send you a fresh one.<br><a href="mailto:broadnaxux@gmail.com">broadnaxux@gmail.com</a></p></div></body></html>`;
  return new Response(html, { status: 410, headers: shareHeaders('text/html; charset=utf-8') });
}

function htmlEscapeAny(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sharePasswordPage(token: string, link: ShareLinkRow, failed = false): string {
  const heading = link.custom_headline || (link.recipient_label ? `Selected work for ${link.recipient_label}` : 'Selected work');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta name="robots" content="noindex,nofollow">
  <title>${htmlEscapeAny(heading)} · Barbara Broadnax</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',-apple-system,sans-serif;background:#fff;color:#150d26;min-height:100vh;display:grid;place-items:center;-webkit-font-smoothing:antialiased;}
    .card{background:#fff;border:1px solid rgba(21,13,38,0.1);padding:2.5rem;border-radius:8px;width:min(420px, 92vw);box-shadow:0 12px 48px rgba(21,13,38,0.04);}
    .eyebrow{font-size:0.6rem;font-weight:800;letter-spacing:0.18em;color:#7c6d90;text-transform:uppercase;margin-bottom:1rem;}
    h1{font-size:1.4rem;font-weight:800;letter-spacing:-0.02em;margin-bottom:0.6rem;line-height:1.25;}
    p.sub{color:#7c6d90;font-size:0.92rem;line-height:1.55;margin-bottom:1.5rem;}
    label{display:block;font-size:0.62rem;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#7c6d90;margin-bottom:0.5rem;}
    input{width:100%;padding:0.75rem 0.85rem;border:1px solid rgba(21,13,38,0.15);border-radius:4px;background:#fff;color:#150d26;font-family:inherit;font-size:0.95rem;}
    input:focus{outline:none;border-color:#2d0a5e;box-shadow:0 0 0 3px rgba(45,10,94,0.1);}
    button{margin-top:1rem;width:100%;padding:0.85rem;background:#2d0a5e;color:#fff;border:0;border-radius:4px;font-family:inherit;font-weight:600;font-size:0.92rem;cursor:pointer;letter-spacing:0.02em;}
    button:hover{filter:brightness(1.1);}
    .err{margin-top:0.85rem;font-size:0.82rem;color:#a02020;min-height:1em;}
  </style>
</head>
<body>
  <form class="card" method="POST" action="/share/${htmlEscapeAny(token)}/unlock">
    <div class="eyebrow">Barbara Broadnax</div>
    <h1>${htmlEscapeAny(heading)}</h1>
    <p class="sub">Enter the password I shared to view this page.</p>
    <label for="password">Password</label>
    <input id="password" type="password" name="password" autofocus required>
    <button type="submit">Unlock</button>
    ${failed ? '<div class="err">Incorrect password.</div>' : '<div class="err"></div>'}
  </form>
</body>
</html>`;
}

interface ShareLandingData { link: ShareLinkRow; caseStudies: CaseStudyRow[]; versionMap: Record<string, string>; }

function shareLandingPage(d: ShareLandingData): string {
  const { link, caseStudies, versionMap } = d;
  const heading = link.custom_headline || (link.recipient_label ? `Selected work for ${link.recipient_label}` : 'Selected work');
  const messageBlock = link.custom_message
    ? `<div class="share-message">${link.custom_message}</div>`
    : '';
  const resumeButton = link.resume_file_key
    ? `<a href="/share/${htmlEscapeAny(link.token)}/resume" target="_blank" rel="noopener" class="resume-btn">Download resume ↓</a>`
    : '';

  const cards = caseStudies.map((cs) => {
    const isPublished = cs.status === 'published';
    const versionId = versionMap[cs.id];
    const versionSuffix = versionId ? `?v=${encodeURIComponent(versionId)}` : '';
    const href = isPublished ? `/work/${attrEscape(cs.id)}${versionSuffix}` : '#';
    const disabledAttr = isPublished ? '' : ' aria-disabled="true" style="opacity:0.55; pointer-events:none;"';
    const draftBadge = !isPublished ? '<span class="record-draft">Draft</span>' : '';
    return `    <a href="${href}"${isPublished ? ` data-slug="${attrEscape(cs.id)}"` : ''} class="record-row"${disabledAttr}>
      <span class="record-company">${htmlEscapeAny(cs.company)}</span>
      <span class="record-project">${htmlEscapeAny(cs.title)}${draftBadge}</span>
      <span class="record-role">${htmlEscapeAny(cs.role ?? '')}</span>
      <span class="record-outcome">${htmlEscapeAny(cs.outcome_metric ?? '')}</span>
      <span class="record-arrow" aria-hidden="true">&#8599;</span>
    </a>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex,nofollow">
  <title>${htmlEscapeAny(heading)} · Barbara Broadnax</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    :root{
      --white:#ffffff; --ink:#150d26; --purple:#2d0a5e;
      --muted:#7c6d90; --rule:rgba(21,13,38,0.1);
      --pad:clamp(1.25rem, 5vw, 4rem);
    }
    html{font-size:16px;scroll-behavior:smooth;}
    body{font-family:'Inter',-apple-system,sans-serif;background:var(--white);color:var(--ink);-webkit-font-smoothing:antialiased;overflow-x:hidden;}
    a{text-decoration:none;color:inherit;}

    nav{position:sticky;top:0;z-index:100;background:var(--white);border-bottom:1px solid var(--rule);height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 var(--pad);gap:2rem;}
    .site-name{display:flex;flex-direction:column;gap:1px;line-height:1;flex-shrink:0;}
    .site-name span{display:block;font-size:0.6rem;font-weight:800;letter-spacing:0.24em;text-transform:uppercase;color:var(--ink);}
    .site-name .name-last{letter-spacing:0.155em;}
    .nav-eyebrow{font-size:0.6rem;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:var(--muted);}

    .hero{padding:5rem var(--pad) 3rem;}
    .hero-eyebrow{font-size:0.62rem;font-weight:800;letter-spacing:0.18em;color:var(--muted);text-transform:uppercase;margin-bottom:1.4rem;}
    .hero h1{font-size:clamp(1.8rem, 3.5vw, 2.6rem);font-weight:800;letter-spacing:-0.03em;line-height:1.18;color:var(--ink);max-width:880px;margin-bottom:1.25rem;}
    .hero h1 em{font-style:normal;color:var(--purple);}

    .share-message{color:var(--ink);font-size:1rem;line-height:1.7;max-width:680px;margin-bottom:1.75rem;}
    .share-message strong{font-weight:600;}
    .share-message a{color:var(--purple);text-decoration:underline;text-underline-offset:3px;}
    .share-message p{margin-bottom:0.85rem;}
    .share-message p:last-child{margin-bottom:0;}

    .resume-btn{display:inline-flex;align-items:center;gap:0.5rem;padding:0.7rem 1.1rem;border:1px solid var(--purple);border-radius:4px;color:var(--purple);font-size:0.78rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;transition:background 0.2s, color 0.2s;}
    .resume-btn:hover{background:var(--purple);color:var(--white);}

    .work-record{padding:0 var(--pad);margin-top:3rem;border-top:1px solid var(--rule);}
    .record-header{display:grid;grid-template-columns:20% 1fr 22% 24%;padding:0.75rem 0;border-bottom:1px solid var(--rule);}
    .record-header span{font-size:0.6rem;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:var(--muted);}

    .record-row{display:grid;grid-template-columns:20% 1fr 22% 24%;align-items:center;margin:0 calc(-1 * var(--pad));padding:1.5rem var(--pad);position:relative;cursor:pointer;color:inherit;text-decoration:none;transition:background 0.25s ease;border-bottom:1px solid var(--rule);}
    .record-row:hover{background:rgba(45,10,94,0.025);}
    .record-row .record-arrow{position:absolute;right:var(--pad);top:50%;translate:4px -50%;opacity:0;font-size:0.75rem;color:var(--purple);transition:opacity 0.2s ease, translate 0.25s cubic-bezier(0.16,1,0.3,1);pointer-events:none;}
    .record-row:hover .record-arrow{opacity:1;translate:0 -50%;}
    .record-company{font-size:0.65rem;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:var(--purple);}
    .record-project{font-size:0.95rem;font-weight:700;color:var(--ink);letter-spacing:-0.01em;}
    .record-role{font-size:0.78rem;font-weight:400;color:var(--muted);}
    .record-outcome{font-size:0.78rem;font-weight:600;color:var(--ink);}
    .record-draft{display:inline-block;font-size:0.55rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:0.15rem 0.5rem;background:rgba(255,200,100,0.15);color:#a17500;border-radius:100px;margin-left:0.5rem;vertical-align:middle;}

    footer{border-top:1px solid var(--rule);padding:2rem var(--pad);display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-top:4rem;}
    footer p{font-size:0.72rem;color:var(--muted);}
    .footer-links{display:flex;gap:1.5rem;list-style:none;}
    .footer-links a{font-size:0.72rem;color:var(--purple);}
    .footer-links a:hover{color:var(--ink);}

    @media (max-width: 860px) {
      .record-header{display:none;}
      .record-row{grid-template-columns:1fr auto;grid-template-rows:auto auto;gap:0.2rem 0;}
      .record-company{grid-column:1;grid-row:1;}
      .record-project{grid-column:1/-1;grid-row:2;font-size:0.88rem;}
      .record-role{display:none;}
      .record-outcome{grid-column:2;grid-row:1;text-align:right;font-size:0.72rem;}
    }
  </style>
</head>
<body>
  <nav>
    <a href="/" class="site-name" aria-label="Barbara Broadnax, home">
      <span class="name-first">Barbara</span>
      <span class="name-last">Broadnax</span>
    </a>
    <span class="nav-eyebrow">${link.recipient_label ? 'Curated for ' + htmlEscapeAny(link.recipient_label) : 'Selected work'}</span>
  </nav>

  <section class="hero">
    <div class="hero-eyebrow">Selected work · Barbara Broadnax</div>
    <h1>${htmlEscapeAny(heading)}</h1>
    ${messageBlock}
    ${resumeButton}
  </section>

  <div class="work-record">
    <div class="record-header">
      <span>Company</span>
      <span>Project</span>
      <span>Role</span>
      <span>Outcome</span>
    </div>
${cards}
  </div>

  <footer>
    <p>&copy; 2026 Barbara Broadnax</p>
    <ul class="footer-links">
      <li><a href="mailto:broadnaxux@gmail.com">Email</a></li>
      <li><a href="https://www.linkedin.com/in/barbarabroadnax" target="_blank" rel="noopener">LinkedIn</a></li>
    </ul>
  </footer>

  <script>
    // Card-click tracking via sendBeacon. Doesn't block navigation.
    document.querySelectorAll('.record-row[data-slug]').forEach(function (el) {
      el.addEventListener('click', function () {
        try {
          var payload = JSON.stringify({ event: 'card_click', case_study_id: el.dataset.slug });
          if (navigator.sendBeacon) {
            navigator.sendBeacon('/share/${htmlEscapeAny(link.token)}/track', new Blob([payload], { type: 'application/json' }));
          } else {
            fetch('/share/${htmlEscapeAny(link.token)}/track', { method: 'POST', body: payload, headers: { 'Content-Type': 'application/json' }, keepalive: true });
          }
        } catch (e) { /* swallow */ }
      });
    });
  </script>
</body>
</html>`;
}
