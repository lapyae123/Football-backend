-- 003_sources_config.sql
-- Add slug + config JSONB to sources; seed scraper sources for admin URL management

ALTER TABLE sources ADD COLUMN IF NOT EXISTS slug   VARCHAR(100) UNIQUE;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}';

INSERT INTO sources (name, slug, driver_type, base_domain, is_active, config) VALUES
  (
    'SocoLive', 'socolive', 'playwright', 'https://www.socolive.tv', true,
    '{
      "base_urls":        ["https://www.socolive.tv", "https://www.barbaramassaad.com"],
      "sync_interval_ms": 300000,
      "description":      "Playwright scraper — Vietnamese football streams"
    }'
  ),
  (
    'ChinaLive', 'chinalive', 'http', 'https://json.yyzb456.top', true,
    '{
      "api_base":         "https://json.yyzb456.top",
      "referer":          "https://yyzbw8.live/",
      "sync_interval_ms": 300000,
      "description":      "HTTP JSON scraper — Chinese sports platform"
    }'
  )
ON CONFLICT (slug) DO NOTHING;
