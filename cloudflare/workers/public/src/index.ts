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
  company_id: string | null;
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

// A company is a brand whose logo + color are reused across all its case
// studies (homepage cards, case-study hero, share landing). Managed in admin.
interface CompanyRow {
  id: string;
  name: string;
  logo_image_key: string | null;
  brand_color: string | null;
}

// Resolved logo info attached to a case study at render time.
interface ResolvedCompany { logoUrl: string; brand: string; name: string; }

async function loadCompanies(env: Env): Promise<CompanyRow[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, name, logo_image_key, brand_color FROM companies`
    ).all<CompanyRow>();
    return results ?? [];
  } catch {
    // companies table not migrated yet — degrade gracefully (no logos).
    return [];
  }
}

interface CompanyLookup { byId: Map<string, CompanyRow>; byName: Map<string, CompanyRow>; }

function buildCompanyLookup(companies: CompanyRow[]): CompanyLookup {
  const byId = new Map<string, CompanyRow>();
  const byName = new Map<string, CompanyRow>();
  for (const c of companies) {
    byId.set(c.id, c);
    byName.set(c.name.trim().toLowerCase(), c);
  }
  return { byId, byName };
}

// Resolve a case study's company logo by company_id first, then by name as a
// fallback so an unlinked study still picks up its brand. Returns null when no
// company matches or the matched company has no logo uploaded.
function resolveCompany(cs: CaseStudyRow, lookup: CompanyLookup): ResolvedCompany | null {
  const c = (cs.company_id && lookup.byId.get(cs.company_id))
    || lookup.byName.get((cs.company ?? '').trim().toLowerCase());
  if (!c || !c.logo_image_key) return null;
  return {
    logoUrl: `/uploads/${attrEscape(c.logo_image_key)}`,
    brand: c.brand_color || '#05334A',
    name: c.name,
  };
}

async function loadPublishedCaseStudies(env: Env): Promise<CaseStudyRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, company, company_id, role, outcome_metric, hero_image_key, body_html,
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
    `SELECT id, title, company, company_id, role, outcome_metric, hero_image_key, body_html,
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
  const [caseStudies, content, companies] = await Promise.all([
    loadPublishedCaseStudies(env),
    loadSiteContent(env),
    loadCompanies(env),
  ]);
  const companyLookup = buildCompanyLookup(companies);

  const tickerPhrases = getJSON<string[]>(content, 'ticker_phrases', []);
  const tickerLabel   = getText(content, 'ticker_label', 'I design');
  const heroRole      = getText(content, 'hero_role', 'Senior Product Designer');
  const heroTagline   = getText(content, 'hero_tagline', DEFAULT_HERO_TAGLINE);
  const footerEmail   = getText(content, 'footer_email', 'broadnaxux@gmail.com');
  const footerLinkedIn= getText(content, 'footer_linkedin', 'https://www.linkedin.com/in/barbarabroadnax');

  const workRowsHtml = caseStudies.map((cs, i) => cineRow(cs, i, resolveCompany(cs, companyLookup))).join('\n');
  const navItems = caseStudies.map((cs) => ({ id: cs.id, title: cs.title, company: cs.company }));

  const html = homepageTemplate({
    tickerPhrases, tickerLabel,
    heroRole, heroTagline,
    workRowsHtml,
    workCount: caseStudies.length,
    navItems,
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

// ─── homepage "cinematic" work rows ──────────────────────────────────────
// The homepage renders each published case study as a full-width cinematic row
// (image one side, copy the other, alternating). The HERO IMAGE and COMPANY
// LOGO come from D1 (admin uploads); the editorial copy (summary / tags /
// outcome stat) is kept faithful to the launch design via a per-slug map, with
// a graceful fallback to D1 fields (subtitle / outcome_metric) for any case
// study not in the map — so a newly added study still renders correctly.
interface HomeCardCopy {
  eyebrow: string;   // "Company · Role · …" line above the title
  summary: string;   // one-line description
  tags: string[];    // small chips
  stat: string;      // big accent outcome number ("$612K", "120%", "New")
  lbl: string;       // outcome label beside the stat
  alt: string;       // hero image alt text
}

const HOME_CARD_COPY: Record<string, HomeCardCopy> = {
  'ipro-ner': {
    eyebrow: 'IPRO · Product Designer · AI',
    summary: 'Designed an AI layer that surfaces people, places, and organizations across millions of legal documents.',
    tags: ['AI Integration', 'Legal Tech', 'Enterprise'],
    stat: '4.13/5', lbl: 'in expert concept testing',
    alt: 'Named Entity Recognition interface showing entity highlighting across document text',
  },
  'inksoft-design-studio': {
    eyebrow: 'InkSoft · UX Designer',
    summary: 'Built a net-new design tool that let print shops sell custom signs and banners online.',
    tags: ['0 → 1', 'E-commerce', 'Tooling'],
    stat: 'New', lbl: 'revenue module, shipped on time',
    alt: 'Design Studio editor with a custom sign layout',
  },
  'alaska-view-reservation': {
    eyebrow: 'Alaska Airlines · Lead Product Designer',
    summary: 'Redesigned the post-purchase reservation page to surface relevant add-ons at the right moment.',
    tags: ['Post-purchase', 'Revenue', 'Native + Web'],
    stat: '120%', lbl: 'lift in car-rental bookings',
    alt: 'View Reservation desktop page showing booking summary and ancillary offers',
  },
  'ipro-search-redact': {
    eyebrow: 'IPRO · Product Designer',
    summary: 'Created an AI-assisted workflow that finds and redacts sensitive content across large document sets.',
    tags: ['AI Integration', 'Legal Tech', 'Enterprise'],
    stat: 'New', lbl: 'AI-powered redaction workflow',
    alt: 'Search and Redact interface with category panel and document preview',
  },
  'ipro-eda': {
    eyebrow: 'IPRO · Product Designer',
    summary: 'Shipped a pre-discovery product area that helps teams assess data before formal review begins.',
    tags: ['0 → 1', 'Workflow', 'Enterprise'],
    stat: 'Net-new', lbl: 'pre-discovery product area',
    alt: 'Early Data Assessment multi-step workflow',
  },
  'alaska-same-day-change': {
    eyebrow: 'Alaska Airlines · Lead Product Designer · 2023',
    summary: 'Redesigned same-day flight changes across native and web into one fast, revenue-driving flow.',
    tags: ['Booking flow', 'Revenue', 'Native + Web'],
    stat: '$612K', lbl: 'in new revenue within the first 6 months',
    alt: 'Same Day Change booking flow showing flight selection',
  },
  'inksoft-ssl': {
    eyebrow: 'InkSoft · UX Designer',
    summary: 'Turned a manual security setup into a self-serve flow store owners could finish on their own.',
    tags: ['Self-serve', 'Security', 'E-commerce'],
    stat: '34% →', lbl: 'near-full SSL adoption',
    alt: 'Easy SSL Install step-by-step configuration wizard',
  },
};

// Frosted logo chip over the bottom-right corner of the cinematic image.
// Renders the admin-uploaded company logo when present; otherwise a brand-tinted
// monogram + wordmark lockup. The real <img> hides the lockup once it loads and
// removes itself if the file is missing (so the lockup stays visible).
function cineLogoChip(company: ResolvedCompany | null, fallbackName: string): string {
  const name = (company?.name ?? fallbackName ?? '').trim();
  const initial = htmlEscape((name || '·').charAt(0).toUpperCase());
  const brand = attrEscape(company?.brand ?? '#05334A');
  // When the company has an uploaded logo (we know this from D1), render the
  // logo visible immediately with `has-logo` already applied — no reliance on a
  // lazy/onload toggle, which fails for display:none images. The monogram +
  // wordmark sit underneath as an onerror fallback if the file 404s at runtime.
  if (company?.logoUrl) {
    return `<div class="cine-logo has-logo">`
      + `<img class="logo-img" src="${company.logoUrl}" alt="${attrEscape(name)}" `
      + `onerror="var p=this.parentElement;if(p){p.classList.remove('has-logo');}this.remove();">`
      + `<span class="mark" style="background:${brand}">${initial}</span>`
      + `<span class="wm">${htmlEscape(name)}</span></div>`;
  }
  return `<div class="cine-logo"><span class="mark" style="background:${brand}">${initial}</span><span class="wm">${htmlEscape(name)}</span></div>`;
}

// One cinematic case-study row. Image side alternates left/right by index.
function cineRow(cs: CaseStudyRow, index: number, company: ResolvedCompany | null = null): string {
  const side = index % 2 === 0 ? 'left' : 'right';
  const copy: HomeCardCopy = HOME_CARD_COPY[cs.id] ?? {
    eyebrow: [cs.company, cs.role].filter(Boolean).join(' · '),
    summary: cs.subtitle ?? '',
    tags: [],
    stat: '',
    lbl: cs.outcome_metric ?? '',
    alt: cs.title,
  };
  const imgUrl = cs.hero_image_key ? `/uploads/${attrEscape(cs.hero_image_key)}` : '';
  const imgEl = imgUrl
    ? `<img src="${imgUrl}" alt="${attrEscape(copy.alt)}" loading="${index < 2 ? 'eager' : 'lazy'}">`
    : '';
  const summaryHtml = copy.summary ? `<p class="cine-sum">${htmlEscape(copy.summary)}</p>` : '';
  const tagsHtml = copy.tags.length
    ? `<div class="cine-tags">${copy.tags.map((t) => `<span class="cine-tag">${htmlEscape(t)}</span>`).join('')}</div>`
    : '';
  const outcomeHtml = (copy.stat || copy.lbl)
    ? `<div class="cine-outcome">${copy.stat ? `<span class="stat">${htmlEscape(copy.stat)}</span>` : ''}${copy.lbl ? `<span class="lbl">${htmlEscape(copy.lbl)}</span>` : ''}</div>`
    : '';
  return `        <a href="/work/${attrEscape(cs.id)}" class="cine" data-side="${side}">
          <div class="cine-media">
            <div class="cine-frame">${imgEl}</div>
            ${cineLogoChip(company, cs.company)}
          </div>
          <div class="cine-copy">
            <p class="cine-co">${htmlEscape(copy.eyebrow)}</p>
            <h3 class="cine-title">${htmlEscape(cs.title)}</h3>
            ${summaryHtml}
            ${tagsHtml}
            ${outcomeHtml}
            <span class="cine-link">View case study <span class="arr">↗</span></span>
          </div>
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

  const [content, companies] = await Promise.all([loadSiteContent(env), loadCompanies(env)]);
  const tickerPhrases = getJSON<string[]>(content, 'ticker_phrases', []);
  const tickerLabel   = getText(content, 'ticker_label', 'I design');
  const footerEmail   = getText(content, 'footer_email', 'broadnaxux@gmail.com');
  const footerLinkedIn= getText(content, 'footer_linkedin', 'https://www.linkedin.com/in/barbarabroadnax');

  const navItems = all.map((x) => ({ id: x.id, title: x.title, company: x.company }));
  const company = resolveCompany(cs, buildCompanyLookup(companies));

  const html = caseStudyTemplate({
    title: cs.title,
    company: cs.company,
    companyLogoUrl: company?.logoUrl ?? '',
    companyBrand: company?.brand ?? '',
    subtitle,
    about_html,
    meta,
    body_html,
    prev, next,
    navItems,
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
    /* Copy email */
    function copyEmail(btn) {
      navigator.clipboard.writeText('broadnaxux@gmail.com').then(function() {
        var orig = btn.innerHTML;
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
        btn.classList.add('copied');
        setTimeout(function() { btn.innerHTML = orig; btn.classList.remove('copied'); }, 2000);
      });
    }

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

interface NavCaseItem { id: string; title: string; company: string; }

// Renders the Case Studies dropdown menu items. `versionMap` (optional) maps a
// case-study id to a version id, appended as ?v=<id> so share-link recipients
// land on the exact version being sent to them.
function caseDropItems(items: NavCaseItem[], versionMap: Record<string, string> = {}): string {
  return items.map((cs) => {
    const v = versionMap[cs.id];
    const suffix = v ? `?v=${encodeURIComponent(v)}` : '';
    return `          <a href="/work/${attrEscape(cs.id)}${suffix}" role="menuitem"><span class="dm-title">${htmlEscape(cs.title)}</span><span class="dm-co">${htmlEscape(cs.company)}</span></a>`;
  }).join('\n');
}

function navHtml(tickerLabel: string, caseStudies: NavCaseItem[] = []): string {
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
      <li class="nav-drop" id="caseDrop">
        <button type="button" class="nav-drop-toggle" aria-haspopup="true" aria-expanded="false" aria-controls="caseDropMenu">Case Studies <span class="caret" aria-hidden="true">&#9662;</span></button>
        <div class="nav-drop-menu" id="caseDropMenu" role="menu" aria-label="Case studies">
${caseDropItems(caseStudies)}
        </div>
      </li>
      <li><a href="/resume.html">Resume</a></li>
      <li><a href="https://www.linkedin.com/in/barbarabroadnax" target="_blank" rel="noopener">LinkedIn</a></li>
      <li><a href="/contact.html">Contact</a></li>
    </ul>
  </nav>`;
}

// Self-contained dropdown styles, parameterised so each page (homepage,
// case-study page, share landing) can pass its own palette tokens.
function navDropdownStyles(o: { accent: string; ink: string; muted: string; rule: string; bg: string }): string {
  return `
    .nav-drop{position:relative;list-style:none;display:inline-flex;align-items:center;}
    .nav-drop-toggle{display:inline-flex;align-items:center;gap:5px;font-family:inherit;font-size:0.68rem;font-weight:600;line-height:1;letter-spacing:0.1em;text-transform:uppercase;color:${o.muted};background:transparent;border:0;padding:6px 0;cursor:pointer;white-space:nowrap;transition:color 0.2s;}
    .nav-drop-toggle:hover{color:${o.accent};}
    .nav-drop-toggle:focus-visible{outline:2px solid ${o.accent};outline-offset:3px;border-radius:2px;}
    .nav-drop-toggle .caret{display:inline-flex;align-items:center;font-size:14px;line-height:1;transition:transform 0.2s;}
    .nav-drop.open .nav-drop-toggle .caret{transform:rotate(180deg);}
    .nav-drop-menu{position:absolute;top:calc(100% + 12px);left:0;min-width:280px;padding:7px;background:${o.bg};border:1px solid ${o.rule};border-radius:8px;box-shadow:0 18px 50px rgba(5,51,74,0.16);opacity:0;transform:translateY(-6px);pointer-events:none;transition:opacity 0.2s,transform 0.2s;z-index:200;}
    .nav-drop.open .nav-drop-menu{opacity:1;transform:translateY(0);pointer-events:auto;}
    .nav-drop-menu a{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:9px 12px;border-radius:4px;transition:background 0.15s;}
    .nav-drop-menu a:hover,.nav-drop-menu a:focus-visible{background:rgba(5,51,74,0.06);outline:none;}
    .nav-drop-menu .dm-title{font-size:0.82rem;font-weight:600;color:${o.ink};white-space:nowrap;text-transform:none;letter-spacing:-0.01em;}
    .nav-drop-menu .dm-co{font-size:0.6rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${o.muted};white-space:nowrap;flex-shrink:0;}
    @media (max-width:560px){.nav-drop-menu{left:auto;right:0;}}
  `;
}

// Toggle behaviour: click to open/close, click-outside + Escape to close,
// arrow keys to move between items. Shared by every page that renders the nav.
function navDropdownScript(): string {
  return `
    (function(){
      var drop=document.getElementById('caseDrop');
      if(!drop)return;
      var toggle=drop.querySelector('.nav-drop-toggle');
      var menu=drop.querySelector('.nav-drop-menu');
      var items=Array.prototype.slice.call(menu.querySelectorAll('a'));
      function openD(){drop.classList.add('open');toggle.setAttribute('aria-expanded','true');}
      function closeD(){drop.classList.remove('open');toggle.setAttribute('aria-expanded','false');}
      function isOpen(){return drop.classList.contains('open');}
      toggle.addEventListener('click',function(e){e.stopPropagation();isOpen()?closeD():openD();});
      document.addEventListener('click',function(e){if(isOpen()&&!drop.contains(e.target))closeD();});
      drop.addEventListener('keydown',function(e){
        if(e.key==='Escape'){closeD();toggle.focus();return;}
        if(e.key==='ArrowDown'||e.key==='ArrowUp'){if(!isOpen())openD();e.preventDefault();var f=items.indexOf(document.activeElement);var d=e.key==='ArrowDown'?1:-1;var n=(f+d+items.length)%items.length;if(items[n])items[n].focus();}
      });
    })();
  `;
}

function footerHtml(email: string, linkedin: string): string {
  const svgCopy = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
  return `  <footer>
    <p>&copy; 2026 Barbara Broadnax</p>
    <ul class="footer-links">
      <li><button class="footer-email-btn" onclick="copyEmail(this)" aria-label="Copy email address">${svgCopy}Email</button></li>
      <li><a href="${attrEscape(linkedin)}" target="_blank" rel="noopener">LinkedIn</a></li>
    </ul>
  </footer>`;
}

// ─── homepage template ───────────────────────────────────────────────────

interface HomeData {
  tickerPhrases: string[];
  tickerLabel: string;
  heroRole: string;
  heroTagline: string;
  workRowsHtml: string;
  workCount: number;
  navItems: NavCaseItem[];
  footerEmail: string;
  footerLinkedIn: string;
}

// Default hero tagline. Used when site_content has no `hero_tagline` row, so
// the homepage still reads well on a fresh DB. Editable in admin once seeded.
const DEFAULT_HERO_TAGLINE = "I design end-to-end experiences built for real people in real situations. Whether it's data management flows or tools that open up new revenue opportunities, I bring a versatile skill set to whatever the problem is. I work closely with product and engineering, lean on research to move quickly, and never lose sight of the bigger picture.";

function homepageTemplate(d: HomeData): string {
  const tagline    = d.heroTagline || DEFAULT_HERO_TAGLINE;
  const tickerLabel = d.tickerLabel || 'I design';
  const phrases = (d.tickerPhrases && d.tickerPhrases.length)
    ? d.tickerPhrases
    : ['cross-functional teams', 'revenue outcomes', 'products at scale', 'AI-powered tools', 'design strategy', 'for complexity'];
  const email    = d.footerEmail || 'broadnaxux@gmail.com';
  const linkedin = d.footerLinkedIn || 'https://www.linkedin.com/in/barbarabroadnax';
  const count    = String(d.workCount).padStart(2, '0');
  const dropItems = d.navItems
    .map((n) => `<a href="/work/${attrEscape(n.id)}" role="menuitem"><span class="dm-title">${htmlEscape(n.title)}</span><span class="dm-co">${htmlEscape(n.company)}</span></a>`)
    .join('\n        ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Barbara Broadnax — Senior Product Designer</title>
<meta name="description" content="Senior Product Designer shipping work across legal tech, aviation, and e-commerce. Eight years turning complex, regulated products into measurable outcomes.">

<meta property="og:type" content="website">
<meta property="og:title" content="Barbara Broadnax — Senior Product Designer">
<meta property="og:description" content="Eight years across legal tech, commercial aviation, and e-commerce. Design that performs.">
<meta property="og:site_name" content="Barbara Broadnax">

<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="Barbara Broadnax — Senior Product Designer">
<meta name="twitter:description" content="Eight years across legal tech, commercial aviation, and e-commerce. Design that performs.">

<link rel="icon" type="image/svg+xml" href="/favicon.svg">

<style>
:root {
  --ink:          #05334A;
  --ink-2:        #3D4550;
  --muted:        #8B7F6A;
  --ink-dark:     #042736;

  --bg:           #FFFFFF;
  --bg-2:         #F4F4F4;
  --bg-card:      #FFFFFF;

  --accent:       #FF5B59;
  --accent-deep:  #E2403E;
  --accent-wash:  rgba(255,91,89,0.10);
  --accent-line:  rgba(255,91,89,0.32);

  --rule:         rgba(5,51,74,0.10);
  --rule-2:       rgba(5,51,74,0.18);
  --rule-dark:    rgba(255,255,255,0.12);

  --r-xs:2px; --r-sm:4px; --r-md:8px; --r-lg:14px; --r-xl:20px; --r-pill:999px;

  --sh-sm: 0 1px 2px rgba(5,51,74,.06), 0 1px 1px rgba(5,51,74,.04);
  --sh-md: 0 10px 30px rgba(5,51,74,.10), 0 2px 6px rgba(5,51,74,.05);
  --sh-lg: 0 30px 70px rgba(5,51,74,.16), 0 4px 10px rgba(5,51,74,.07);

  --ease: cubic-bezier(0.16, 1, 0.3, 1);
  --d1: 120ms; --d2: 240ms; --d3: 420ms;

  --display: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  --sans:    -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  --mono:    ui-monospace, 'SF Mono', Menlo, 'Cascadia Code', monospace;

  --gutter: clamp(1.25rem, 5vw, 4rem);
  --max: 1200px;
  --nav-h: 56px;
  --bottom-nav-h: 56px;
}

*, *::before, *::after { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
a { color: inherit; text-decoration: none; }
img { display: block; max-width: 100%; }

.wrap { max-width: var(--max); margin: 0 auto; padding-inline: var(--gutter); }

.eyebrow {
  font-family: var(--mono);
  font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.18em;
  color: var(--accent); margin: 0;
}

.progress-bar {
  position: fixed;
  top: var(--nav-h);
  left: 0; height: 2px; width: 0%;
  background: var(--accent);
  z-index: 200;
  transition: width 60ms linear;
  pointer-events: none;
}

.nav {
  position: sticky; top: 0; z-index: 100;
  height: var(--nav-h);
  display: flex; align-items: center;
  padding: 0 var(--gutter);
  gap: 18px;
  background: rgba(255,255,255,0.94);
  backdrop-filter: blur(14px) saturate(1.1);
  border-bottom: 1px solid var(--rule);
}

.brand {
  display: flex; flex-direction: column;
  line-height: 1.04; flex-shrink: 0;
}
.brand b {
  font-family: var(--display);
  font-weight: 700; font-size: 13px;
  letter-spacing: 0.22em;
}
.brand b + b { letter-spacing: 0.135em; }

.nav-divider {
  width: 1px; height: 20px;
  background: var(--rule-2); flex-shrink: 0;
}

.ticker {
  display: flex; align-items: center; gap: 7px;
  flex: 1; min-width: 0; overflow: hidden;
}
.ticker-label {
  font-size: 11.5px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--ink-2); white-space: nowrap; line-height: 1;
  flex-shrink: 0;
}
.ticker-track {
  position: relative; height: 1em; overflow: hidden;
  min-width: 140px; max-width: 200px;
}
.ticker-word {
  position: absolute; inset: 0;
  display: flex; align-items: center;
  font-size: 11.5px; font-weight: 700;
  letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--accent); white-space: nowrap;
  opacity: 0; transform: translateY(110%); line-height: 1;
}
.ticker-word.is-in  { animation: wordIn  0.4s var(--ease) forwards; }
.ticker-word.is-out { animation: wordOut 0.3s ease-in forwards; }
@keyframes wordIn  { from { opacity:0; transform:translateY(110%) } to { opacity:1; transform:translateY(0) } }
@keyframes wordOut { from { opacity:1; transform:translateY(0) }    to { opacity:0; transform:translateY(-110%) } }

.nav-links {
  display: flex; gap: 18px;
  margin-left: auto; align-items: center; flex-shrink: 0;
}
.nav-links .nav-resume,
.nav-links .nav-cta { margin-left: 4px; }

.nav-links > a:not(.nav-resume):not(.nav-cta) {
  font-size: 13px; font-weight: 500; color: var(--ink-2);
  position: relative; padding: 6px 0;
  transition: color var(--d1); white-space: nowrap;
}
.nav-links > a:not(.nav-resume):not(.nav-cta):hover { color: var(--ink); }
.nav-links > a:not(.nav-resume):not(.nav-cta)::after {
  content: '';
  position: absolute; left: 0; right: 100%; bottom: 0;
  height: 1.5px; background: var(--accent);
  transition: right var(--d2) var(--ease);
}
.nav-links > a:not(.nav-resume):not(.nav-cta):hover::after,
.nav-links > a.on::after { right: 0; }
.nav-links > a.on { color: var(--ink); }

.nav-resume {
  display: inline-flex; align-items: center;
  font-size: 12.5px; font-weight: 600;
  color: var(--ink) !important;
  background: transparent;
  padding: 7px 16px;
  border-radius: var(--r-sm);
  border: 1.5px solid rgba(5,51,74,0.25);
  white-space: nowrap; line-height: 1;
  transition: border-color var(--d2);
}
.nav-resume::after { display: none !important; }
.nav-resume:hover { border-color: var(--ink); }

.nav-cta {
  display: inline-flex; align-items: center;
  font-size: 12.5px; font-weight: 600;
  color: #fff !important;
  background: var(--ink);
  padding: 7px 16px;
  border-radius: var(--r-sm);
  white-space: nowrap; line-height: 1;
  transition: background var(--d2);
}
.nav-cta::after { display: none !important; }
.nav-cta:hover { background: var(--accent); }

.nav-drop { position: relative; display: inline-flex; align-items: center; }
.nav-drop-toggle {
  display: inline-flex; align-items: center; gap: 5px;
  font-family: var(--sans); font-size: 13px; font-weight: 500;
  line-height: 1;
  color: var(--ink-2); background: transparent; border: 0;
  padding: 7px 2px; cursor: pointer; white-space: nowrap;
  transition: color var(--d1);
}
.nav-drop-toggle:hover,
.nav-drop[aria-expanded="true"] .nav-drop-toggle { color: var(--ink); }
.nav-drop-toggle .caret {
  display: inline-flex; align-items: center;
  font-size: 14px; line-height: 1;
  transition: transform var(--d2) var(--ease);
}
.nav-drop.open .nav-drop-toggle .caret { transform: rotate(180deg); }

.nav-drop-menu {
  position: absolute; top: calc(100% + 10px); left: 0;
  min-width: 280px; padding: 7px;
  background: rgba(255,255,255,0.98);
  backdrop-filter: blur(14px) saturate(1.1);
  border: 1px solid var(--rule);
  border-radius: var(--r-md);
  box-shadow: var(--sh-lg);
  opacity: 0; transform: translateY(-6px) scale(0.985);
  transform-origin: top left;
  pointer-events: none;
  transition: opacity var(--d2) var(--ease), transform var(--d2) var(--ease);
  z-index: 120;
}
.nav-drop.open .nav-drop-menu {
  opacity: 1; transform: translateY(0) scale(1);
  pointer-events: auto;
}
.nav-drop-menu a {
  display: flex; align-items: baseline; justify-content: space-between; gap: 16px;
  padding: 9px 12px; border-radius: var(--r-sm);
  transition: background var(--d1);
}
.nav-drop-menu a::after { display: none !important; }
.nav-drop-menu a:hover,
.nav-drop-menu a:focus-visible { background: var(--bg-2); outline: none; }
.nav-drop-menu .dm-title {
  font-size: 13.5px; font-weight: 500; color: var(--ink);
  letter-spacing: -0.01em; white-space: nowrap;
}
.nav-drop-menu .dm-co {
  font-family: var(--mono); font-size: 10px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--muted); white-space: nowrap; flex-shrink: 0;
}

.nav > * {
  opacity: 0; transform: translateY(-5px);
  animation: navIn 0.45s var(--ease) forwards;
}
.nav > *:nth-child(1) { animation-delay: 0ms; }
.nav > *:nth-child(2) { animation-delay: 50ms; }
.nav > *:nth-child(3) { animation-delay: 100ms; }
.nav > *:nth-child(4) { animation-delay: 150ms; }
@keyframes navIn { to { opacity: 1; transform: translateY(0); } }

.nav-bottom {
  display: none;
}

.hero {
  padding: clamp(3.5rem,8vw,6rem) 0 clamp(3rem,5vw,4.5rem);
}
.hero-head {
  margin: 0 0 clamp(1.75rem,4vw,2.6rem);
}
.hero-main {
  display: grid;
  grid-template-columns: 1.3fr 1fr;
  gap: clamp(2rem,5vw,4.5rem);
  align-items: end;
}
.hero-aside { align-self: end; }
.hero-status {
  display: inline-flex; align-items: center; gap: 9px;
  margin: 0;
  padding: 7px 14px 7px 12px;
  background: var(--accent-wash);
  border: 1px solid var(--accent-line);
  border-radius: var(--r-pill);
}
.hero-status .dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--accent);
  animation: pulse 2.4s var(--ease) infinite;
}
@keyframes pulse {
  0%   { box-shadow: 0 0 0 0 rgba(255,91,89,.45); }
  70%  { box-shadow: 0 0 0 7px rgba(255,91,89,0); }
  100% { box-shadow: 0 0 0 0 rgba(255,91,89,0); }
}
.hero-status span {
  font-family: var(--mono); font-size: 11px; font-weight: 600;
  letter-spacing: 0.05em; color: var(--accent-deep);
  text-transform: uppercase;
}
.hero h1 {
  font-family: var(--display); font-weight: 700; color: var(--ink);
  font-size: clamp(2.3rem,5vw,4rem);
  line-height: 1.02; letter-spacing: -0.035em;
  margin: 0; text-wrap: balance;
}
.hero h1 .accent { color: var(--accent); }
.hero-lede {
  font-size: clamp(1rem,1.4vw,1.14rem);
  line-height: 1.62; color: var(--ink-2);
  max-width: 44ch; margin: 0 0 28px;
}
.hero-meta { display: flex; flex-wrap: wrap; gap: 10px 28px; }
.hero-meta div { display: flex; flex-direction: column; gap: 3px; }
.hero-meta dt {
  font-family: var(--mono); font-size: 10px; font-weight: 600;
  letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--muted); margin: 0;
}
.hero-meta dd {
  font-size: 14px; font-weight: 500; color: var(--ink); margin: 0;
}
.hero-portrait { display: none; }

.companies {
  padding: clamp(2.5rem,5vw,4rem) 0;
  border-top: 1px solid var(--rule);
}
.companies-head {
  display: flex; align-items: baseline;
  justify-content: space-between; gap: 1rem;
  margin-bottom: 34px;
}
.companies-head p.note {
  font-size: 13.5px; color: var(--muted);
  margin: 0; max-width: 30ch; text-align: right;
}
.co-grid {
  display: grid; grid-template-columns: repeat(3,1fr); gap: 0;
}
.co {
  padding: 28px 28px 28px 0;
  border-top: 1px solid var(--rule);
}
.co + .co {
  padding-left: 28px;
  border-left: 1px solid var(--rule);
}
.co-name {
  font-family: var(--display); font-weight: 700;
  font-size: clamp(1.5rem,2.4vw,2rem);
  letter-spacing: -0.025em; margin: 0 0 4px;
}
.co-role {
  font-family: var(--mono); font-size: 11px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--accent-deep); margin: 0 0 14px;
}
.co-industry {
  font-family: var(--mono); font-size: 10.5px;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--muted); margin: 0 0 12px;
}
.co-desc {
  font-size: 13.5px; line-height: 1.6;
  color: var(--ink-2); margin: 0;
}

.work {
  padding: clamp(3rem,6vw,5rem) 0 clamp(2rem,4vw,3rem);
  border-top: 1px solid var(--rule);
}
.work-head {
  display: flex; align-items: flex-end;
  justify-content: space-between; gap: 1.5rem;
  margin-bottom: 38px; flex-wrap: wrap;
}
.work-head h2 {
  font-family: var(--display); font-weight: 700;
  font-size: clamp(1.7rem,3vw,2.4rem);
  letter-spacing: -0.03em; margin: 10px 0 0;
}
.work-head .count {
  font-family: var(--mono); font-size: 12px; color: var(--muted);
}

.work-grid {
  display: flex; flex-direction: column;
  gap: clamp(4.5rem, 10vw, 9rem);
}

.cine {
  display: grid;
  grid-template-columns: 1.04fr 0.96fr;
  align-items: center;
  gap: clamp(1.75rem, 5vw, 5rem);
  color: inherit;
}
.cine[data-side="right"] .cine-media { order: 2; }
.cine[data-side="right"] .cine-copy  { order: 1; }

.cine-media {
  position: relative;
  transform: translateY(var(--py, 0));
  will-change: transform;
}
.cine-frame {
  position: relative;
  border-radius: var(--r-lg);
  overflow: hidden;
  background: var(--bg-2);
  border: 1px solid var(--rule);
  box-shadow: var(--sh-md);
  aspect-ratio: 16 / 10;
}
.cine-frame img {
  width: 100%; height: 100%;
  object-fit: cover; display: block;
  transform: scale(1.14);
  transition: transform 1.3s var(--ease);
  will-change: transform;
}
.cine.in .cine-frame img { transform: scale(1); }
.cine:hover .cine-frame img { transform: scale(1.05); }

.cine-frame::after {
  content: ''; position: absolute; inset: -1px; z-index: 2;
  background: var(--bg);
  transform-origin: bottom; transform: scaleY(1);
  transition: transform 0.95s var(--ease);
}
.cine.in .cine-frame::after { transform: scaleY(0); }

.cine-logo {
  position: absolute; z-index: 3;
  right: clamp(-8px, -0.8vw, -14px);
  bottom: clamp(-8px, -0.8vw, -14px);
  display: inline-flex; align-items: center; gap: 10px;
  padding: 10px 15px 10px 11px;
  background: rgba(255,255,255,0.9);
  backdrop-filter: blur(12px) saturate(1.3);
  border: 1px solid var(--rule);
  border-radius: var(--r-md);
  box-shadow: var(--sh-md);
  opacity: 0; transform: translateY(14px) scale(0.94);
  transition: opacity 0.5s var(--ease), transform 0.6s var(--ease);
  transition-delay: 0.5s;
}
.cine.in .cine-logo { opacity: 1; transform: translateY(0) scale(1); }
.cine:hover .cine-logo { transform: translateY(-3px) scale(1); }
.cine-logo .mark {
  width: 30px; height: 30px; flex-shrink: 0;
  border-radius: 7px; display: grid; place-items: center;
  font-family: var(--display); font-weight: 700;
  font-size: 14px; color: #fff;
  background: #05334A;
}
.cine-logo .wm {
  font-family: var(--display); font-weight: 700;
  font-size: 14px; letter-spacing: -0.01em; color: var(--ink);
  white-space: nowrap;
}
.cine-logo .logo-img { display: none; height: 30px; width: auto; max-width: 132px; object-fit: contain; }
.cine-logo.has-logo .logo-img { display: inline-block; }
.cine-logo.has-logo .mark,
.cine-logo.has-logo .wm { display: none; }

.cine-copy { max-width: 30rem; }
.cine-copy > * {
  opacity: 0; transform: translateY(14px);
  transition: opacity 0.6s var(--ease), transform 0.6s var(--ease);
}
.cine.in .cine-copy > * { opacity: 1; transform: none; }
.cine.in .cine-copy > *:nth-child(1) { transition-delay: 0.10s; }
.cine.in .cine-copy > *:nth-child(2) { transition-delay: 0.16s; }
.cine.in .cine-copy > *:nth-child(3) { transition-delay: 0.22s; }
.cine.in .cine-copy > *:nth-child(4) { transition-delay: 0.28s; }
.cine.in .cine-copy > *:nth-child(5) { transition-delay: 0.34s; }
.cine.in .cine-copy > *:nth-child(6) { transition-delay: 0.40s; }

.cine-co {
  font-family: var(--mono); font-size: 11px; font-weight: 600;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--muted); margin: 0 0 12px;
}
.cine-title {
  font-family: var(--display); font-weight: 700;
  font-size: clamp(1.7rem, 2.8vw, 2.5rem); letter-spacing: -0.03em;
  line-height: 1.05; margin: 0 0 16px;
}
.cine-sum {
  font-size: clamp(0.98rem, 1.2vw, 1.1rem); line-height: 1.6;
  color: var(--ink-2); margin: 0 0 20px; max-width: 42ch;
}
.cine-tags {
  display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 20px;
}
.cine-tag {
  font-family: var(--mono); font-size: 10px; font-weight: 500;
  letter-spacing: 0.04em; color: var(--ink-2);
  background: var(--bg-2); border: 1px solid var(--rule);
  padding: 4px 9px; border-radius: var(--r-sm);
}
.cine-outcome {
  display: flex; align-items: baseline; gap: 10px; margin: 0 0 22px;
}
.cine-outcome .stat {
  font-family: var(--display); font-weight: 700;
  font-size: clamp(1.4rem, 2vw, 1.9rem); letter-spacing: -0.02em;
  color: var(--accent-deep);
}
.cine-outcome .lbl { font-size: 14px; color: var(--ink-2); }
.cine-link {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 14px; font-weight: 600; color: var(--ink);
  transition: color var(--d2); white-space: nowrap;
}
.cine-link .arr { transition: transform var(--d2) var(--ease); }
.cine:hover .cine-link { color: var(--accent-deep); }
.cine:hover .cine-link .arr { transform: translate(3px,-3px); }

.side {
  margin-top: clamp(3rem,6vw,5rem);
  background: var(--ink); color: var(--bg);
  padding: clamp(3rem,6vw,4.5rem) 0;
}
.side-head {
  display: flex; align-items: flex-end;
  justify-content: space-between;
  gap: 1.5rem; flex-wrap: wrap; margin-bottom: 30px;
}
.side-head .l h2 {
  font-family: var(--display); font-weight: 700;
  font-size: clamp(1.5rem,2.6vw,2rem);
  letter-spacing: -0.025em; margin: 12px 0 0; color: var(--bg);
}
.side-head .l .eyebrow { color: var(--accent); }
.side-head .r {
  font-size: 14px; line-height: 1.6;
  color: rgba(251,248,241,.7); max-width: 38ch; margin: 0;
}
.side-grid {
  display: grid; grid-template-columns: repeat(2,1fr); gap: 14px;
}
.spc {
  display: flex; align-items: center; gap: 18px; padding: 20px 22px;
  background: var(--ink-dark);
  border: 1px solid var(--rule-dark);
  border-radius: var(--r-md);
  transition: border-color var(--d2), transform var(--d2) var(--ease);
}
.spc:hover { border-color: var(--accent-line); transform: translateY(-2px); }
.spc-mark {
  width: 46px; height: 46px; flex-shrink: 0;
  border-radius: var(--r-sm);
  background: linear-gradient(135deg, #0A4862, var(--ink-dark));
  border: 1px solid var(--rule-dark);
  display: flex; align-items: center; justify-content: center;
  font-family: var(--display); font-weight: 700; font-size: 15px; color: var(--bg);
}
.spc .m { flex: 1; min-width: 0; }
.spc-live {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--mono); font-size: 9.5px; font-weight: 600;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--accent); margin-bottom: 5px;
}
.spc-live .d {
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--accent); box-shadow: 0 0 7px var(--accent);
}
.spc-name {
  font-family: var(--display); font-weight: 600;
  font-size: 1.05rem; letter-spacing: -0.015em;
  margin: 0 0 2px; color: var(--bg);
}
.spc-desc {
  font-size: 12.5px; line-height: 1.45;
  color: rgba(251,248,241,.6); margin: 0;
}
.spc .arr {
  color: rgba(251,248,241,.4); font-size: 16px;
  transition: transform var(--d2) var(--ease), color var(--d2);
}
.spc:hover .arr { color: var(--accent); transform: translate(3px,-3px); }

.contact { padding: clamp(3.5rem,7vw,6rem) 0; }
.contact-in {
  display: grid; grid-template-columns: 1.4fr 1fr;
  gap: clamp(2rem,5vw,4rem); align-items: end;
}
.contact h2 {
  font-family: var(--display); font-weight: 700;
  font-size: clamp(2rem,4.5vw,3.4rem);
  letter-spacing: -0.035em; line-height: 1.02;
  margin: 18px 0 0; text-wrap: balance;
}
.contact h2 a {
  color: var(--accent); text-decoration: none;
  border-bottom: 2px solid transparent;
  transition: border-color var(--d2);
}
.contact h2 a:hover { border-color: var(--accent); }
.contact-links { display: flex; flex-direction: column; gap: 2px; }
.contact-links a {
  display: flex; align-items: center; justify-content: space-between;
  padding: 15px 2px; border-top: 1px solid var(--rule);
  font-size: 15px; font-weight: 500; color: var(--ink);
  transition: padding-left var(--d2) var(--ease), color var(--d2);
}
.contact-links a:last-child { border-bottom: 1px solid var(--rule); }
.contact-links a:hover { padding-left: 8px; color: var(--accent-deep); }
.contact-links a .arr {
  color: var(--muted);
  transition: transform var(--d2) var(--ease), color var(--d2);
}
.contact-links a:hover .arr { transform: translate(3px,-3px); color: var(--accent); }
.contact h2 .email-copy {
  font: inherit; background: none; cursor: pointer; padding: 0;
  color: var(--accent); border: 0; border-bottom: 2px solid transparent;
  transition: border-color var(--d2);
}
.contact h2 .email-copy:hover { border-bottom-color: var(--accent); }
.contact-links .email-copy {
  display: flex; align-items: center; justify-content: space-between; width: 100%;
  font: inherit; background: none; border: 0; cursor: pointer; text-align: left;
  padding: 15px 2px; border-top: 1px solid var(--rule);
  font-size: 15px; font-weight: 500; color: var(--ink);
  transition: padding-left var(--d2) var(--ease), color var(--d2);
}
.contact-links .email-copy:hover { padding-left: 8px; color: var(--accent-deep); }
.contact-links .email-copy .arr { color: var(--muted); transition: transform var(--d2) var(--ease), color var(--d2); }
.contact-links .email-copy:hover .arr { transform: translate(3px,-3px); color: var(--accent); }
.contact-links .email-copy.copied, .contact h2 .email-copy.copied { color: #16a34a; }

.foot {
  border-top: 1px solid var(--rule);
  margin-top: 32px;
  padding: 24px 0 40px;
  display: flex; align-items: center;
  justify-content: space-between; gap: 1rem; flex-wrap: wrap;
}
.foot p {
  font-family: var(--mono); font-size: 11.5px;
  color: var(--muted); margin: 0; letter-spacing: 0.03em;
}
.foot .foot-links { display: flex; gap: 20px; }
.foot .foot-links a {
  font-size: 12.5px; color: var(--muted); transition: color var(--d1);
}
.foot .foot-links a:hover { color: var(--accent); }

.reveal {
  opacity: 0; transform: translateY(16px);
  transition: opacity var(--d3) var(--ease), transform var(--d3) var(--ease);
}
.reveal.in { opacity: 1; transform: none; }

@media (max-width: 960px) {
  .ticker { display: none; }
  .nav-divider { display: none; }
}

@media (max-width: 900px) {
  .hero-main { grid-template-columns: 1fr; gap: clamp(1.5rem,5vw,2rem); align-items: start; }
  .hero h1 { margin: 0 0 4px; }
  .co-grid { grid-template-columns: 1fr; }
  .co + .co { padding-left: 0; border-left: none; }
  .work-grid { gap: clamp(3.5rem, 9vw, 6rem); }
  .cine,
  .cine[data-side="right"] {
    grid-template-columns: 1fr;
    gap: 1.75rem;
  }
  .cine[data-side="right"] .cine-media,
  .cine[data-side="right"] .cine-copy { order: 0; }
  .cine-copy { max-width: none; }
  .side-grid { grid-template-columns: 1fr; }
  .contact-in { grid-template-columns: 1fr; align-items: start; }
}

@media (max-width: 768px) {

  .nav {
    height: 48px;
    justify-content: center;
  }
  .nav .nav-divider,
  .nav .ticker,
  .nav .nav-links { display: none; }
  .brand { align-items: center; }

  .progress-bar { display: none; }

  .cine-logo {
    right: 8px; bottom: 8px;
    padding: 8px 12px 8px 9px;
  }
  .cine-logo .mark { width: 26px; height: 26px; font-size: 13px; }
  .cine-logo .wm { font-size: 13px; }
  .cine-logo .logo-img { height: 24px; max-width: 104px; }

  .nav-bottom {
    display: block;
    position: fixed;
    bottom: 0; left: 0; right: 0;
    z-index: 100;
    background: rgba(255,255,255,0.96);
    backdrop-filter: blur(14px) saturate(1.1);
    border-top: 1px solid var(--rule);
  }

  .nav-bottom .progress-bar {
    display: block;
    position: absolute;
    top: 0; left: 0;
    height: 2px; width: 0%;
    background: var(--accent);
    pointer-events: none;
    transition: width 60ms linear;
  }

  .nav-bottom-links {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 10px 16px;
    padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
    height: calc(var(--bottom-nav-h) + env(safe-area-inset-bottom, 0px));
  }

  .nav-bottom-links a:not(.nav-resume):not(.nav-cta) {
    font-size: 12px; font-weight: 500; color: var(--ink-2);
    white-space: nowrap;
    transition: color var(--d1);
  }
  .nav-bottom-links a:not(.nav-resume):not(.nav-cta).on { color: var(--ink); font-weight: 600; }
  .nav-bottom-links a:not(.nav-resume):not(.nav-cta):hover { color: var(--ink); }

  .nav-bottom-links .nav-resume {
    display: inline-flex; align-items: center;
    font-size: 11.5px; font-weight: 600;
    color: var(--ink) !important;
    background: transparent;
    padding: 6px 11px;
    border-radius: var(--r-sm);
    border: 1.5px solid rgba(5,51,74,0.25);
    white-space: nowrap; line-height: 1;
    transition: border-color var(--d2);
  }
  .nav-bottom-links .nav-resume:hover { border-color: var(--ink); }

  .nav-bottom-links .nav-cta {
    display: inline-flex; align-items: center;
    font-size: 11.5px; font-weight: 600;
    color: #fff !important;
    background: var(--ink);
    padding: 6px 11px;
    border-radius: var(--r-sm);
    white-space: nowrap; line-height: 1;
    transition: background var(--d2);
  }
  .nav-bottom-links .nav-cta:hover { background: var(--accent); }

  main {
    padding-bottom: calc(var(--bottom-nav-h) + env(safe-area-inset-bottom, 0px) + 1rem);
  }

  .companies-head p.note { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .reveal { opacity: 1 !important; transform: none !important; }
  .hero-status .dot { animation: none; }
  .nav > * { animation: none; opacity: 1; transform: none; }

  .cine-media { transform: none !important; }
  .cine-frame img { transform: none !important; }
  .cine-frame::after { transform: scaleY(0) !important; }
  .cine-logo,
  .cine-copy > * { opacity: 1 !important; transform: none !important; transition: none !important; }
}
</style>
</head>
<body>

<div class="progress-bar" id="progress-desktop"></div>

<header class="nav">
  <a href="#top" class="brand" aria-label="Barbara Broadnax, home">
    <b>BARBARA</b>
    <b>BROADNAX</b>
  </a>
  <div class="nav-divider" aria-hidden="true"></div>
  <div class="ticker">
    <span class="ticker-label">${htmlEscape(tickerLabel)}</span>
    <div class="ticker-track" id="ticker-track" aria-live="polite"></div>
  </div>
  <nav class="nav-links" aria-label="Site navigation">
    <div class="nav-drop" id="caseDrop">
      <button type="button" class="nav-drop-toggle" aria-haspopup="true" aria-expanded="false" aria-controls="caseDropMenu">
        Case Studies <span class="caret" aria-hidden="true">▾</span>
      </button>
      <div class="nav-drop-menu" id="caseDropMenu" role="menu" aria-label="Case studies">
        ${dropItems}
      </div>
    </div>
    <a href="/resume.html" class="nav-resume">Resume</a>
    <a href="${attrEscape(linkedin)}" target="_blank" rel="noopener" class="nav-resume">LinkedIn</a>
    <a href="#contact" class="nav-cta">Get in touch</a>
  </nav>
</header>

<nav class="nav-bottom" aria-label="Site navigation">
  <div class="progress-bar" id="progress-mobile"></div>
  <div class="nav-bottom-links">
    <a href="#work" class="nav-resume">Case Studies</a>
    <a href="/resume.html" class="nav-resume">Resume</a>
    <a href="${attrEscape(linkedin)}" target="_blank" rel="noopener" class="nav-resume">LinkedIn</a>
    <a href="#contact" class="nav-cta">Get in touch</a>
  </div>
</nav>

<main id="top">

  <section class="hero">
    <div class="wrap">
      <div class="hero-head reveal">
        <div class="hero-status">
          <span class="dot"></span>
          <span>Open to senior &amp; lead roles</span>
        </div>
      </div>
      <div class="hero-main">
        <h1 class="reveal">Senior product designer turning complex, regulated products into <span class="accent">measurable outcomes.</span></h1>
        <div class="hero-aside reveal">
          <p class="hero-lede">${htmlEscape(tagline)}</p>
          <dl class="hero-meta">
            <div><dt>Based</dt><dd>Phoenix, AZ · Remote</dd></div>
            <div><dt>Now</dt><dd>Alaska Airlines</dd></div>
            <div><dt>Focus</dt><dd>Product · AI · Accessibility</dd></div>
          </dl>
        </div>
      </div>
    </div>
  </section>

  <section class="companies" id="companies">
    <div class="wrap">
      <div class="companies-head reveal">
        <p class="eyebrow">Experience</p>
        <p class="note">Three industries, each with its own constraints, regulations, and high-stakes users.</p>
      </div>
      <div class="co-grid">
        <div class="co reveal">
          <h3 class="co-name">IPRO</h3>
          <p class="co-role">Product Designer</p>
          <p class="co-industry">Legal technology</p>
          <p class="co-desc">Enterprise e-discovery software that helps legal teams review and produce millions of documents in litigation and investigations.</p>
        </div>
        <div class="co reveal">
          <h3 class="co-name">Alaska Airlines</h3>
          <p class="co-role">Lead Product Designer</p>
          <p class="co-industry">Commercial aviation</p>
          <p class="co-desc">A major U.S. carrier serving tens of millions of travelers a year across booking, check-in, and post-purchase, on legacy infrastructure under DOT regulation.</p>
        </div>
        <div class="co reveal">
          <h3 class="co-name">InkSoft</h3>
          <p class="co-role">UX Designer</p>
          <p class="co-industry">E-commerce</p>
          <p class="co-desc">A storefront and design platform for custom print-shop owners to build stores, create artwork, and manage orders. Built for small-business operators.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="work" id="work">
    <div class="wrap">
      <div class="work-head reveal">
        <div>
          <p class="eyebrow">Selected work</p>
        </div>
        <span class="count">${count} case studies</span>
      </div>

      <div class="work-grid">
${d.workRowsHtml}
      </div>
    </div>
  </section>

  <section class="side" id="building">
    <div class="wrap">
      <div class="side-head">
        <div class="l reveal">
          <p class="eyebrow">Now building</p>
          <h2>On my own terms.</h2>
        </div>
        <p class="r reveal">Side projects keep me honest. No sprint planning, no stakeholders. Just decisions I make for tools I believe in.</p>
      </div>
      <div class="side-grid">
        <a href="https://mtrcd.com" target="_blank" rel="noopener" class="spc reveal">
          <div class="spc-mark">M</div>
          <div class="m">
            <span class="spc-live"><span class="d"></span>Live</span>
            <h3 class="spc-name">MTRCD — WCAG Guide</h3>
            <p class="spc-desc">An accessibility reference built as a product design exercise, not a prompt exercise.</p>
          </div>
          <span class="arr">↗</span>
        </a>
        <a href="https://thelezlist.com" target="_blank" rel="noopener" class="spc reveal">
          <div class="spc-mark">L</div>
          <div class="m">
            <span class="spc-live"><span class="d"></span>Live</span>
            <h3 class="spc-name">The Lez List</h3>
            <p class="spc-desc">Connecting Black lesbians and queer women to events and experiences, by us, for us.</p>
          </div>
          <span class="arr">↗</span>
        </a>
      </div>
    </div>
  </section>

  <section class="contact" id="contact">
    <div class="wrap contact-in">
      <div class="reveal">
        <p class="eyebrow">Let's talk</p>
        <h2>Hiring for a senior or lead design role? <button type="button" class="email-copy" onclick="copyEmail(this)" aria-label="Copy email address">Let's talk.</button></h2>
      </div>
      <div class="contact-links reveal">
        <button type="button" class="email-copy" onclick="copyEmail(this)" aria-label="Copy email address"><span class="ec-label">${htmlEscape(email)}</span> <span class="arr">⧉</span></button>
        <a href="${attrEscape(linkedin)}" target="_blank" rel="noopener">LinkedIn <span class="arr">↗</span></a>
        <a href="/resume.html">Download resume <span class="arr">↓</span></a>
      </div>
    </div>
    <div class="wrap">
      <div class="foot">
        <p>© 2026 Barbara Broadnax · Phoenix, AZ</p>
        <div class="foot-links">
          <a href="#work">Work</a>
          <a href="#contact">Contact</a>
          <a href="/resume.html">Resume</a>
        </div>
      </div>
    </div>
  </section>

</main>

<script>
  var CONTACT_EMAIL = ${JSON.stringify(email)};
  function copyEmail(btn) {
    navigator.clipboard.writeText(CONTACT_EMAIL).then(function () {
      var labelEl = btn.querySelector('.ec-label');
      var target = labelEl || btn;
      var orig = target.textContent;
      target.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(function () { target.textContent = orig; btn.classList.remove('copied'); }, 2000);
    });
  }

  var progD = document.getElementById('progress-desktop');
  var progM = document.getElementById('progress-mobile');
  function updateProgress() {
    var scrolled = window.scrollY;
    var total = document.documentElement.scrollHeight - window.innerHeight;
    var pct = total > 0 ? (scrolled / total * 100).toFixed(2) + '%' : '0%';
    if (progD) progD.style.width = pct;
    if (progM) progM.style.width = pct;
  }
  window.addEventListener('scroll', updateProgress, { passive: true });
  window.addEventListener('resize', updateProgress, { passive: true });
  updateProgress();

  var phrases = ${JSON.stringify(phrases)};
  var track = document.getElementById('ticker-track');
  var current = 0;
  phrases.forEach(function (p, i) {
    var span = document.createElement('span');
    span.className = 'ticker-word';
    span.textContent = p;
    span.id = 'tw-' + i;
    track.appendChild(span);
  });
  function showWord(i) {
    var el = document.getElementById('tw-' + i);
    if (!el) return;
    el.classList.add('is-in');
    el.addEventListener('animationend', function () {
      el.classList.remove('is-in');
      el.style.opacity = 1;
      el.style.transform = 'translateY(0)';
    }, { once: true });
  }
  function hideWord(i) {
    var el = document.getElementById('tw-' + i);
    if (!el) return;
    el.style.opacity = '';
    el.style.transform = '';
    el.classList.add('is-out');
    el.addEventListener('animationend', function () {
      el.classList.remove('is-out');
      el.style.opacity = 0;
    }, { once: true });
  }
  if (phrases.length) {
    showWord(0);
    setInterval(function () {
      hideWord(current);
      current = (current + 1) % phrases.length;
      setTimeout(function () { showWord(current); }, 320);
    }, 2600);
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        var el = e.target;
        var sibs = Array.from(el.parentElement.querySelectorAll(':scope > .reveal'));
        var idx = Math.max(0, sibs.indexOf(el));
        el.style.transitionDelay = (idx * 70) + 'ms';
        el.classList.add('in');
        io.unobserve(el);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var cines = Array.from(document.querySelectorAll('.cine'));
  var cio = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        cio.unobserve(e.target);
      }
    });
  }, { threshold: 0.18, rootMargin: '0px 0px -10% 0px' });
  cines.forEach(function (c) { cio.observe(c); });

  if (!reduceMotion) {
    var frames = Array.from(document.querySelectorAll('.cine-media'));
    var ticking = false;
    function parallax() {
      var vh = window.innerHeight;
      frames.forEach(function (f) {
        var r = f.getBoundingClientRect();
        if (r.bottom < -80 || r.top > vh + 80) return;
        var off = ((r.top + r.height / 2) - vh / 2) / vh;
        f.style.setProperty('--py', (off * -20).toFixed(1) + 'px');
      });
      ticking = false;
    }
    window.addEventListener('scroll', function () {
      if (!ticking) { requestAnimationFrame(parallax); ticking = true; }
    }, { passive: true });
    window.addEventListener('resize', parallax, { passive: true });
    parallax();
  }

  var drop = document.getElementById('caseDrop');
  if (drop) {
    var toggle = drop.querySelector('.nav-drop-toggle');
    var menu = drop.querySelector('.nav-drop-menu');
    var items = Array.from(menu.querySelectorAll('a'));
    function openDrop() { drop.classList.add('open'); toggle.setAttribute('aria-expanded', 'true'); }
    function closeDrop() { drop.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); }
    function isOpen() { return drop.classList.contains('open'); }
    toggle.addEventListener('click', function (e) { e.stopPropagation(); isOpen() ? closeDrop() : openDrop(); });
    document.addEventListener('click', function (e) { if (isOpen() && !drop.contains(e.target)) closeDrop(); });
    drop.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeDrop(); toggle.focus(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!isOpen()) openDrop();
        e.preventDefault();
        var focused = items.indexOf(document.activeElement);
        var dir = e.key === 'ArrowDown' ? 1 : -1;
        var nextIdx = (focused + dir + items.length) % items.length;
        items[nextIdx].focus();
      }
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
  companyLogoUrl: string;
  companyBrand: string;
  subtitle: string;
  about_html: string;
  meta: MetaItem[];
  body_html: string;
  prev: CaseStudyRow | null;
  next: CaseStudyRow | null;
  navItems: NavCaseItem[];
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
  <style>${navDropdownStyles({ accent: '#FF5B59', ink: '#05334A', muted: '#8B7F6A', rule: 'rgba(5,51,74,0.1)', bg: '#FFFFFF' })}
    .case-company{display:flex;align-items:center;gap:0.6rem;margin-bottom:0.5rem;}
    .case-company .label{margin:0;}
    .case-company-logo{display:inline-flex;align-items:center;justify-content:center;width:102px;height:102px;}
    .case-company-logo img{width:100%;height:100%;object-fit:contain;display:block;}
  </style>
</head>
<body>

${navHtml(d.tickerLabel, d.navItems)}

  <section class="case-hero">
    <div class="container">
      <div class="case-company animate-in">${d.companyLogoUrl
        ? `<span class="case-company-logo" style="--brand:${attrEscape(d.companyBrand)}"><img src="${attrEscape(d.companyLogoUrl)}" alt="${attrEscape(d.company)}"></span>`
        : ''}<p class="label">${htmlEscape(d.company)}</p></div>
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
${navDropdownScript()}
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
    body { font-family: 'Inter', -apple-system, sans-serif; background: #FBF8F1; color: #05334A; min-height: 100vh; display: grid; place-items: center; margin: 0; padding: 2rem; text-align: center; }
    a { color: #FF5B59; }
  </style>
</head>
<body>
  <div>
    <h1 style="font-size: 1.5rem; font-weight: 700; margin-bottom: 0.75rem;">Not found</h1>
    <p style="color: #8B7F6A;">That page doesn't exist. <a href="/">Go home</a>.</p>
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
    `SELECT id, title, company, company_id, role, outcome_metric, hero_image_key, body_html,
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
  const [caseStudies, companies] = await Promise.all([
    loadCaseStudiesByIds(env, ids),
    loadCompanies(env),
  ]);
  const companyLookup = buildCompanyLookup(companies);

  // Track open (dedup per browser via simple cookie that lasts the session)
  const cookies = parseCookies(request.headers.get('Cookie') ?? '');
  const seen = cookies[shareSeenCookie(token)];
  const setCookies: string[] = [];
  if (!seen) {
    await recordView(env, request, link.id, 'open');
    setCookies.push(`${shareSeenCookie(token)}=1; HttpOnly; Secure; SameSite=Strict; Path=/share/${token}; Max-Age=86400`);
  }

  const versionMap = parseVersionMap(link.case_study_versions);
  const html = shareLandingPage({ link, caseStudies, versionMap, companyLookup });
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
<style>body{font-family:'Inter',-apple-system,sans-serif;background:#FBF8F1;color:#05334A;min-height:100vh;display:grid;place-items:center;margin:0;padding:2rem;text-align:center;}a{color:#FF5B59;}</style></head>
<body><div><h1 style="font-size:1.4rem;font-weight:700;margin-bottom:0.6rem;">This link doesn't exist</h1>
<p style="color:#8B7F6A;">The URL may be wrong or the link may have been deleted.<br><a href="/">Visit barbarabroadnax.com</a>.</p></div></body></html>`;
  return new Response(html, { status: 404, headers: shareHeaders('text/html; charset=utf-8') });
}

function shareExpiredPage(): Response {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Link expired · Barbara Broadnax</title>
<meta name="robots" content="noindex,nofollow">
<style>body{font-family:'Inter',-apple-system,sans-serif;background:#FBF8F1;color:#05334A;min-height:100vh;display:grid;place-items:center;margin:0;padding:2rem;text-align:center;}a{color:#FF5B59;}
.email-copy{background:none;border:none;cursor:pointer;font-family:inherit;font-size:inherit;color:#FF5B59;padding:0;display:inline-flex;align-items:center;gap:0.35rem;transition:color 0.2s;}
.email-copy:hover{color:#05334A;}.email-copy.copied{color:#16a34a;}</style></head>
<body><div><h1 style="font-size:1.4rem;font-weight:700;margin-bottom:0.6rem;">This link has expired</h1>
<p style="color:#8B7F6A;">Reach out and I'll send you a fresh one.<br><button class="email-copy" onclick="copyEmail(this)" aria-label="Copy email address">broadnaxux@gmail.com<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button></p></div>
<script>function copyEmail(btn){navigator.clipboard.writeText('broadnaxux@gmail.com').then(function(){var o=btn.innerHTML;btn.innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg> Copied!';btn.classList.add('copied');setTimeout(function(){btn.innerHTML=o;btn.classList.remove('copied');},2000);});}</script>
</body></html>`;
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
    body{font-family:'Inter',-apple-system,sans-serif;background:#FBF8F1;color:#05334A;min-height:100vh;display:grid;place-items:center;-webkit-font-smoothing:antialiased;}
    .card{background:#fff;border:1px solid rgba(5,51,74,0.1);padding:2.5rem;border-radius:8px;width:min(420px, 92vw);box-shadow:0 12px 48px rgba(5,51,74,0.04);}
    .eyebrow{font-size:0.6rem;font-weight:800;letter-spacing:0.18em;color:#8B7F6A;text-transform:uppercase;margin-bottom:1rem;}
    h1{font-size:1.4rem;font-weight:800;letter-spacing:-0.02em;margin-bottom:0.6rem;line-height:1.25;}
    p.sub{color:#8B7F6A;font-size:0.92rem;line-height:1.55;margin-bottom:1.5rem;}
    label{display:block;font-size:0.62rem;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#8B7F6A;margin-bottom:0.5rem;}
    input{width:100%;padding:0.75rem 0.85rem;border:1px solid rgba(5,51,74,0.15);border-radius:4px;background:#fff;color:#05334A;font-family:inherit;font-size:0.95rem;}
    input:focus{outline:none;border-color:#FF5B59;box-shadow:0 0 0 3px rgba(255,91,89,0.15);}
    button{margin-top:1rem;width:100%;padding:0.85rem;background:#FF5B59;color:#fff;border:0;border-radius:4px;font-family:inherit;font-weight:600;font-size:0.92rem;cursor:pointer;letter-spacing:0.02em;}
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

interface ShareLandingData { link: ShareLinkRow; caseStudies: CaseStudyRow[]; versionMap: Record<string, string>; companyLookup: CompanyLookup; }

function shareLandingPage(d: ShareLandingData): string {
  const { link, caseStudies, versionMap, companyLookup } = d;
  const heading = link.custom_headline || (link.recipient_label ? `Selected work for ${link.recipient_label}` : 'Selected work');
  const messageBlock = link.custom_message
    ? `<div class="share-message">${link.custom_message}</div>`
    : '';
  const resumeButton = link.resume_file_key
    ? `<a href="/share/${htmlEscapeAny(link.token)}/resume" target="_blank" rel="noopener" class="resume-btn">Download resume ↓</a>`
    : '';

  // Version-aware nav dropdown: only published studies, each linked to the
  // exact version curated for this recipient (via versionMap → ?v=<id>).
  const navItems = caseStudies
    .filter((cs) => cs.status === 'published')
    .map((cs) => ({ id: cs.id, title: cs.title, company: cs.company }));
  const navDrop = navItems.length
    ? `      <div class="nav-drop" id="caseDrop">
        <button type="button" class="nav-drop-toggle" aria-haspopup="true" aria-expanded="false" aria-controls="caseDropMenu">Case Studies <span class="caret" aria-hidden="true">&#9662;</span></button>
        <div class="nav-drop-menu" id="caseDropMenu" role="menu" aria-label="Case studies">
${caseDropItems(navItems, versionMap)}
        </div>
      </div>`
    : '';

  const cards = caseStudies.map((cs) => {
    const isPublished = cs.status === 'published';
    const versionId = versionMap[cs.id];
    const versionSuffix = versionId ? `?v=${encodeURIComponent(versionId)}` : '';
    const href = isPublished ? `/work/${attrEscape(cs.id)}${versionSuffix}` : '#';
    const disabledAttr = isPublished ? '' : ' aria-disabled="true" style="opacity:0.55; pointer-events:none;"';
    const draftBadge = !isPublished ? '<span class="record-draft">Draft</span>' : '';
    const rc = resolveCompany(cs, companyLookup);
    const logoEl = rc
      ? `<span class="record-logo" style="--brand:${attrEscape(rc.brand)}"><img src="${rc.logoUrl}" alt="${attrEscape(rc.name)}"></span>`
      : '';
    return `    <a href="${href}"${isPublished ? ` data-slug="${attrEscape(cs.id)}"` : ''} class="record-row"${disabledAttr}>
      <span class="record-company">${logoEl}${htmlEscapeAny(cs.company)}</span>
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
      --white:#FFFFFF; --ink:#05334A; --purple:#FF5B59;
      --muted:#8B7F6A; --rule:rgba(5,51,74,0.1);
      --pad:clamp(1.25rem, 5vw, 4rem);
    }
    html{font-size:16px;scroll-behavior:smooth;}
    body{font-family:'Inter',-apple-system,sans-serif;background:var(--white);color:var(--ink);-webkit-font-smoothing:antialiased;overflow-x:hidden;}
    a{text-decoration:none;color:inherit;}

    nav{position:sticky;top:0;z-index:100;background:var(--white);border-bottom:1px solid var(--rule);height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 var(--pad);gap:2rem;}
    .site-name{display:flex;flex-direction:column;gap:1px;line-height:1;flex-shrink:0;}
    .site-name span{display:block;font-size:13px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:var(--ink);}
    .site-name .name-last{letter-spacing:0.135em;}
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
    .record-row:hover{background:rgba(255,91,89,0.05);}
    .record-row .record-arrow{position:absolute;right:var(--pad);top:50%;translate:4px -50%;opacity:0;font-size:0.75rem;color:var(--purple);transition:opacity 0.2s ease, translate 0.25s cubic-bezier(0.16,1,0.3,1);pointer-events:none;}
    .record-row:hover .record-arrow{opacity:1;translate:0 -50%;}
    .record-company{font-size:0.65rem;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:var(--purple);display:flex;align-items:center;gap:0.5rem;}
    .record-logo{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:4px;border-radius:6px;background:color-mix(in srgb, var(--brand,#05334A) 12%, #ffffff);border:1px solid color-mix(in srgb, var(--brand,#05334A) 22%, transparent);flex-shrink:0;}
    .record-logo img{width:100%;height:100%;object-fit:contain;display:block;}
    .record-project{font-size:0.95rem;font-weight:700;color:var(--ink);letter-spacing:-0.01em;}
    .record-role{font-size:0.78rem;font-weight:400;color:var(--muted);}
    .record-outcome{font-size:0.78rem;font-weight:600;color:var(--ink);}
    .record-draft{display:inline-block;font-size:0.55rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:0.15rem 0.5rem;background:rgba(255,200,100,0.15);color:#a17500;border-radius:100px;margin-left:0.5rem;vertical-align:middle;}

    footer{border-top:1px solid var(--rule);padding:2rem var(--pad);display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-top:4rem;}
    footer p{font-size:0.72rem;color:var(--muted);}
    .footer-links{display:flex;gap:1.5rem;list-style:none;align-items:center;}
    .footer-links a{font-size:0.72rem;color:var(--purple);}
    .footer-links a:hover{color:var(--ink);}
    .footer-email-btn{background:none;border:none;cursor:pointer;font-family:inherit;font-size:0.72rem;color:var(--purple);padding:0;display:inline-flex;align-items:center;gap:0.35rem;transition:color 0.2s;line-height:1;}
    .footer-email-btn:hover{color:var(--ink);}
    .footer-email-btn.copied{color:#16a34a;}

    @media (max-width: 860px) {
      .record-header{display:none;}
      .record-row{grid-template-columns:1fr auto;grid-template-rows:auto auto;gap:0.2rem 0;}
      .record-company{grid-column:1;grid-row:1;}
      .record-project{grid-column:1/-1;grid-row:2;font-size:0.88rem;}
      .record-role{display:none;}
      .record-outcome{grid-column:2;grid-row:1;text-align:right;font-size:0.72rem;}
    }
    .nav-right{display:flex;align-items:center;gap:1.5rem;}
    @media (max-width:560px){.nav-right .nav-eyebrow{display:none;}}
${navDropdownStyles({ accent: '#FF5B59', ink: '#05334A', muted: '#8B7F6A', rule: 'rgba(5,51,74,0.1)', bg: '#FFFFFF' })}
  </style>
</head>
<body>
  <nav>
    <a href="/" class="site-name" aria-label="Barbara Broadnax, home">
      <span class="name-first">Barbara</span>
      <span class="name-last">Broadnax</span>
    </a>
    <div class="nav-right">
${navDrop}
      <span class="nav-eyebrow">${link.recipient_label ? 'Curated for ' + htmlEscapeAny(link.recipient_label) : 'Selected work'}</span>
    </div>
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
      <li><button class="footer-email-btn" onclick="copyEmail(this)" aria-label="Copy email address"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>Email</button></li>
      <li><a href="https://www.linkedin.com/in/barbarabroadnax" target="_blank" rel="noopener">LinkedIn</a></li>
    </ul>
  </footer>

  <script>
    // Copy email to clipboard (matches the rest of the site).
    function copyEmail(btn) {
      navigator.clipboard.writeText('broadnaxux@gmail.com').then(function() {
        var orig = btn.innerHTML;
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
        btn.classList.add('copied');
        setTimeout(function() { btn.innerHTML = orig; btn.classList.remove('copied'); }, 2000);
      });
    }
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
${navDropdownScript()}
  </script>
</body>
</html>`;
}
