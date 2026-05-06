-- Initial seed for site_content. Already applied to the live database.
-- Pulled from the current homepage (index.html) on 2026-05-01.

INSERT OR REPLACE INTO site_content (key, value, value_type, updated_at) VALUES
  ('ticker_phrases',
   '["cross-functional teams","revenue outcomes","products at scale","AI-powered tools","design strategy","for complexity"]',
   'json', unixepoch()),
  ('ticker_label', 'I design', 'text', unixepoch()),
  ('thesis_line_1', 'Three industries. Seven shipped products', 'text', unixepoch()),
  ('thesis_line_2', 'One through-line: design that performs.', 'text', unixepoch()),
  ('asterisk_tooltip',
   'Just the projects shown here. I''ve shipped quite a few more. A good designer knows when to edit. 😉',
   'text', unixepoch()),
  ('co_eyebrow', 'The companies', 'text', unixepoch()),
  ('company_context',
   '[{"index":"01","name":"IPRO","industry":"Legal technology","description":"Enterprise software that helps legal teams manage, review, and produce millions of documents in litigation and investigations. High stakes, complex workflows, zero room for error."},{"index":"02","name":"Alaska Airlines","industry":"Commercial aviation","description":"A major U.S. carrier serving tens of millions of travelers each year. Digital products span booking, check-in, and post-purchase experiences, all while navigating DOT regulations and legacy infrastructure."},{"index":"03","name":"InkSoft","industry":"E-commerce","description":"A platform for custom print shop owners to run storefronts, create designs, and manage orders. Built for small business operators who need powerful tools without enterprise complexity."}]',
   'json', unixepoch()),
  ('record_header', '["Company","Project","Role","Outcome"]', 'json', unixepoch()),
  ('footer_email', 'broadnaxux@gmail.com', 'text', unixepoch()),
  ('footer_linkedin', 'https://www.linkedin.com/in/barbarabroadnax', 'text', unixepoch());
