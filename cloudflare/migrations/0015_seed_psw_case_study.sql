-- 0015_seed_psw_case_study.sql
-- Seeds the (unlisted) Alaska Premium Search Widget case study.
-- 'unlisted' status: renders at /work/alaska-premium-search-widget, but stays
-- off the homepage, the nav dropdown, and search engines. Reachable only by
-- direct link. Re-running this overwrites the row (INSERT OR REPLACE), so if
-- you later edit the study in admin, do NOT re-apply this file.

INSERT OR REPLACE INTO case_studies
  (id, title, company, role, outcome_metric, body_html, status, sort_order,
   subtitle, about_html, meta_items, tags, kind, created_at, updated_at)
VALUES (
  'alaska-premium-search-widget',
  'Premium Search Widget',
  'Alaska Airlines',
  'Senior Product Designer',
  'A slim, AI-built guided flight search',
  '<style>
  .img-ph{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.55rem;aspect-ratio:16/10;border:1.5px dashed rgba(13,27,30,0.22);border-radius:16px;background:repeating-linear-gradient(45deg,rgba(18,116,117,0.045) 0 16px,transparent 16px 32px),var(--bg,#FBFEF9);color:var(--muted,#8B7F6A);text-align:center;padding:1.75rem;}
  .img-ph .img-ph-tag{font-size:.66rem;letter-spacing:.14em;text-transform:uppercase;color:var(--accent,#E2403E);font-weight:700;}
  .img-ph .img-ph-t{font-weight:700;color:var(--ink,#0D1B1E);font-size:1rem;}
  .img-ph .img-ph-d{font-size:.85rem;max-width:42ch;line-height:1.4;}
  .image-showcase-grid .img-ph{aspect-ratio:4/3;}
</style>

<div class="image-showcase">
  <div class="img-ph"><span class="img-ph-tag">Image to add</span><span class="img-ph-t">Final widget (hero)</span><span class="img-ph-d">The shipped slim, guided Premium Search Widget. Use your strongest single hero shot.</span></div>
  <p class="image-caption">The Premium Search Widget. A slim, guided search that can sit inline on the page or float in as a modal.</p>
</div>

<section class="case-section">
  <div class="container">
    <p class="label">Context</p>
    <h2>An overstimulating widget on the way to going global</h2>
    <p>This was my first project with the Revenue team after three years on post-booking. Our principal PM wanted to rebuild the search widget on Alaska''s main page, the front door to every booking on the site.</p>
    <p>The existing widget had launched in early summer 2025 and the feedback was not kind. The call center logged a steady stream of complaints, and we could see users getting stuck on parts of the flow, like booking children traveling alone. The widget tried to do everything at once, and it was overstimulating.</p>
    <div class="callout">
      <p>At the same time, Alaska was becoming a global airline through the Hawaiian integration. Leadership wanted something sleeker and more premium, while still giving credit card offers and promotions a place front and center.</p>
    </div>
    <p>So the brief had two halves: calm a cluttered, confusing experience, and make it feel like the front door of a modern global carrier.</p>
  </div>
</section>

<div class="image-showcase">
  <div class="img-ph"><span class="img-ph-tag">Image to add</span><span class="img-ph-t">Original search widget</span><span class="img-ph-d">The dense, pre-redesign widget you were designing against.</span></div>
  <p class="image-caption">The version we were designing against. Everything competing for attention at once.</p>
</div>

<section class="case-section">
  <div class="container">
    <p class="label">Discovery</p>
    <h2>Starting at the source, with AI as a research partner</h2>
    <p>This was the first project where we used AI tools at every stage of the design process, and discovery set the tone. We opened with a cross-functional workshop, but everyone did homework first. Product gathered the business needs and the timeline. Engineering dug into the existing search infrastructure. My design partner and I went to the call center and listened to live calls, so we understood the pain at the source instead of secondhand.</p>
    <p>Then we ran the existing widget through AI tools, including Claude and Cowork, to pressure-test where the real opportunities were. It gave us a fast, unbiased read on the problems before we ever opened Figma.</p>
  </div>
</section>

<section class="case-section">
  <div class="container">
    <p class="label">Define</p>
    <h2>Finding the core problem in the noise</h2>
    <p>The workshop ran two days. We had a lot of inputs: accessibility goals, the negative feedback from the call center, and a moving set of business needs as we folded in Hawaiian and pushed to become a global airline. The hard part was not gathering data, it was discerning the one core problem underneath all of it.</p>
    <p>We used AI to organize and cross-reference everything we already had, so the signal rose above the noise. The root issue came into focus: the widget forced every decision on the user at once. The fix was not adding or removing features. It was sequencing them.</p>
  </div>
</section>

<section class="case-section">
  <div class="container">
    <p class="label">Develop</p>
    <h2>Letting users and AI vote</h2>
    <p>This was the most fun part. We ideated manually from the compiled research, and in the background I ran the same data through a range of tools: ChatGPT 5, Opus 4.5 via Lovable, an early version of Microsoft''s Copilot Cowork, and Figma Make. I ran the experiments deliberately. First I fed the models only the data and reviewed what they produced. Then I asked them to use that same data to redesign our existing widget, and compared the results.</p>
    <p>Every time an iteration felt strong, we put it into an A/B test against the last winning version. In the first round we tested three: two new directions against the existing widget.</p>
    <div class="callout">
      <p>70% of users chose a version built around a side panel. It felt less overstimulating and easier to navigate. That result told me what people actually wanted: a dead-simple widget that still held every option, so they could set up a search fast without absorbing a wall of little elements.</p>
    </div>
    <p>To move quickly, these studies ran with anywhere from 30 to 90 participants. I used UserTesting.com''s AI features to set the tests up automatically, then used ChatGPT and Claude Sonnet to synthesize the results and draft shareouts that kept our accessibility, copywriting, and stakeholder partners current on where the work stood.</p>
  </div>
</section>

<div class="image-showcase">
  <div class="img-ph"><span class="img-ph-tag">Image to add</span><span class="img-ph-t">Early mockups</span><span class="img-ph-d">A few of the early directions you A/B tested against each other.</span></div>
  <p class="image-caption">Early directions. We A/B tested favorites against the last winner instead of debating in a vacuum.</p>
</div>

<section class="case-section">
  <div class="container">
    <p class="label">Deliver</p>
    <h2>Three options, one slim widget</h2>
    <p>I brought three directions to stakeholders: a layout that opened in a side panel, a version that simply improved the existing widget, and the one I believed in most, a slim modular widget narrow enough to live anywhere, whether inline on the page or as a modal.</p>
    <p>There was a wrinkle. Leadership had historically been skeptical of user testing, because travelers'' interest in flying as cheaply as possible can run against the business goal of maximizing the value of every seat. So to earn deeper buy-in, I leaned on the AI evaluations of each design alongside the user data, and that combination is what moved the room.</p>
    <p>I got alignment all the way up to our executive director on the slim widget. They loved that it could sit above or below promotions on the home page, float back in when a traveler wanted to change their search, and stay narrow enough to absorb new features later.</p>
  </div>
</section>

<div class="image-showcase">
  <div class="img-ph"><span class="img-ph-tag">Image to add</span><span class="img-ph-t">The three options</span><span class="img-ph-d">Side panel, improved status quo, and the slim modular widget, shown side by side.</span></div>
  <p class="image-caption">The three options. Side panel, improved status quo, and the slim modular widget we shipped.</p>
</div>

<section class="case-section">
  <div class="container">
    <p class="label">Resolving a hard call</p>
    <h2>Settling a senior disagreement with data, not hierarchy</h2>
    <p>Late in the project, two people I respected disagreed. My design director wanted to keep travelers in the main row of actions, the pattern Expedia and Delta use. The PM, whose vision drove the project, wanted to move travelers up and out of the main flow, after I resurfaced an earlier discovery: 65% of people who complete a booking on our site are solo travelers. His logic was sound. In a guided widget, why make two-thirds of users complete a step they don''t need?</p>
    <p>Both arguments held up, so I went back to the funnel data, and the fuller picture reframed the question. 83% of desktop users had only one traveler selected when they clicked search, but only 65% actually booked for one traveler. Just over 24% of the rest changed their traveler count before they checked out. People were missing the traveler selector during search and fixing it later. The "tuck it out of the way" pattern, common as it is, was quietly causing users to get their search wrong the first time. And because traveler count drives both price and availability, a missed selector means inaccurate fares and possibly the wrong flights.</p>
    <p>That turned the debate from "where does the field go" into "what does hiding it cost us." To answer the half of it I didn''t have data for, whether keeping travelers prominent taxes solo users, I designed the smallest experiment that would settle it: a quick study with 20 users across a range of elite tiers, focused on one question. Does selecting travelers on a solo booking feel like friction?</p>
    <div class="callout">
      <p>Zero of the 20 expressed any frustration. Several read it the opposite way, as a chance to confirm their details after the brisk pace of the rest of the widget. Both data sources pointed the same direction: travelers stayed in the main set of actions, prominent enough that people set their search right the first time, and light enough that solo travelers never felt taxed.</p>
    </div>
  </div>
</section>

<section class="case-section">
  <div class="container">
    <p class="label">Craft</p>
    <h2>Working out the details, and one calculated risk</h2>
    <p>With the direction locked, I got the widget to its slimmest possible form and worked through the harder scenarios. What are the error states? What happens if a user tries to jump ahead of the guided flow? We set up formal reviews with our legal and accessibility teams to make sure we met every regulatory obligation, and I relied on AI to comb back through pages of our collected data to answer questions quickly as the deadline closed in.</p>
    <p>When I felt we had the final version, I did what I had done at the very beginning: I ran it back through the AI tools and asked whether it met the needs we had defined in the kickoff workshop. The results were positive, with one consistent flag. Both ChatGPT and Claude Opus advised against a strict guided flow.</p>
    <p>My PM and I already knew that risk. We chose to take it, because we planned to add features that would grow this from a search box into a discovery tool. To de-risk the bet, we brought engineering in early and asked how to build it so we could loosen the guided flow quickly if the data ever told us to.</p>
  </div>
</section>

<div class="image-showcase">
  <div class="img-ph"><span class="img-ph-tag">Image to add</span><span class="img-ph-t">Accessibility spec</span><span class="img-ph-d">The annotated widget spec you walked through with legal and accessibility.</span></div>
  <p class="image-caption">One of the specs we walked through with legal and accessibility to meet our regulatory obligations.</p>
</div>

<section class="case-section">
  <div class="container">
    <p class="label">Validation</p>
    <h2>Testing the final flow, including the risk</h2>
    <p>I closed the project the way I opened it, with a test. We ran a desktop usability study with 15 participants across three segments: 5 Alaska elites, 5 Alaska non-elites, and 5 frequent flyers on other carriers. The point was to see whether the guided, linear flow held up on a larger screen, and where people hit friction.</p>
    <p>The flow held. All 15 reached a results screen, and not one tripped the "entered too early" recovery path we had built for people who fight a guided flow. Users described it as familiar and intuitive, "standard in a good way," and several compared it favorably to other travel sites. That was the direct answer to the risk both AI tools had flagged: the linear gating worked.</p>
    <div class="stats-grid">
      <div class="stat-card"><p class="stat-number">15</p><p class="stat-label">testers across elites, non-elites, and competitor frequent flyers</p></div>
      <div class="stat-card"><p class="stat-number">0</p><p class="stat-label">tripped the guided-flow recovery path</p></div>
      <div class="stat-card"><p class="stat-number">33%</p><p class="stat-label">missed the discount-code field, our clearest next fix</p></div>
    </div>
    <p>The study also caught a real problem, which is exactly why we run them. A third of users never saw the discount-code entry, because it sits earlier than the "codes go at checkout" mental model expects. The placement is not wrong, but it needs more visual weight and an immediate success state to override that instinct. So the next steps wrote themselves: elevate the discount code inside its step, confirm it inline, and keep the primary action always visible.</p>
  </div>
</section>

<section class="case-section">
  <div class="container">
    <p class="label">What it unlocks</p>
    <h2>From a search form to a trip-planning tool</h2>
    <p>To better support how travelers actually plan trips, and to enable smarter results, I turned Alaska''s flight search from a traditional form into a guided flow. Rather than presenting every field at once, the experience reveals the next step as each input is completed, moving through origin, destination, dates, travelers, and advanced options in a logical sequence. That reduces cognitive load, simplifies the decisions, and feels far more approachable for new and infrequent travelers.</p>
    <p>The guided flow also opens up business and personalization opportunities, because each step can use what the traveler already entered to enrich the next. Once someone picks an origin and destination, the date step can surface lowest fares, award availability, destination insights, and personalized recommendations. That shifts search from a static form to fill out into an intelligent trip-planning experience, and lays a foundation for future merchandising and personalization.</p>
    <p>Then engineering shared something that set my head spinning: a new version of our search infrastructure that would let travelers search in plain language in the city fields. I immediately started designing for it. Picture a traveler with their departure city already set who, instead of typing "Hawaii," types "20k points" and gets a list of places they could actually go. That is where this widget is headed.</p>
  </div>
</section>

<div class="container">
  <div class="image-showcase-grid">
    <div class="image-showcase"><div class="img-ph"><span class="img-ph-tag">Image to add</span><span class="img-ph-t">Final design, Alaska theme</span><span class="img-ph-d">The shipped widget themed for Alaska.</span></div><p class="image-caption">The shipped design, themed for Alaska.</p></div>
    <div class="image-showcase"><div class="img-ph"><span class="img-ph-tag">Image to add</span><span class="img-ph-t">Final design, Hawaiian theme</span><span class="img-ph-d">The same modular widget themed for Hawaiian.</span></div><p class="image-caption">The same modular widget, themed for Hawaiian.</p></div>
  </div>
</div>',
  'unlisted',
  900,
  'Rebuilding Alaska''s flagship flight search from an overstimulating form into a slim, guided widget that can live anywhere, designed with AI at every stage of the process.',
  '<p class="label">About Alaska Airlines</p><p>Alaska Airlines is a Seattle-based carrier with roughly 2,000 daily departures and the largest presence at SEA. Founded in 1932, Alaska grew up serving the Pacific Northwest, then went global in 2024 with the acquisition of Hawaiian Airlines.</p>',
  '[{"label":"Role","value":"Senior Product Designer"},{"label":"Team","value":"Product, Engineering, Design, UX Research"},{"label":"Impact","value":"70% preferred the simpler design"}]',
  '["Guided Flow","AI-Assisted Design","Travel","Conversion"]',
  'work',
  unixepoch(),
  unixepoch()
);
