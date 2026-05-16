-- 005_xoilac_tab.sql
-- Add XoiLac tab and source for Vietnamese football streaming

-- Tab
INSERT INTO tabs (name, slug, source_type, position, is_active, icon)
VALUES ('XoiLac', 'xoilac', 'scraper', 6, true, '🇻🇳')
ON CONFLICT (slug) DO NOTHING;

-- Source
INSERT INTO sources (name, slug, driver_type, base_domain, is_active, config)
VALUES (
  'XoiLac', 'xoilac', 'http', 'https://xoilacct.tv', true,
  '{
    "base_url":         "https://xoilacct.tv",
    "stream_host":      "https://xl365.livepingscorex.com",
    "api_base":         "https://fb-api.sportliveapiz.com",
    "referer":          "https://xoilacct.tv/",
    "sync_interval_ms": 300000,
    "description":      "HTTP scraper — Vietnamese football streams (xoilacct.tv). Change base_url here if the domain changes."
  }'
)
ON CONFLICT (slug) DO NOTHING;
