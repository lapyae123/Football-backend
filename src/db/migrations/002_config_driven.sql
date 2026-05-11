-- 002_config_driven.sql
-- Config-driven architecture: extend tabs with display metadata, add app_config store

ALTER TABLE tabs ADD COLUMN IF NOT EXISTS icon        VARCHAR(30) DEFAULT '⚽';
ALTER TABLE tabs ADD COLUMN IF NOT EXISTS color       VARCHAR(20) DEFAULT '#00FF87';
ALTER TABLE tabs ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE tabs ADD COLUMN IF NOT EXISTS config      JSONB NOT NULL DEFAULT '{}';

UPDATE tabs SET
  icon        = '⚡',
  color       = '#00FF87',
  description = 'Top live matches from all sources',
  config      = '{"aggregates":["soco-live","china-live","loungsan"],"maxMatches":10}'
WHERE slug = 'main-live';

UPDATE tabs SET
  icon        = '🔴',
  color       = '#FF4444',
  description = 'Live matches from SocoLive.tv',
  config      = '{"source":"socolive"}'
WHERE slug = 'soco-live';

UPDATE tabs SET
  icon        = '🇨🇳',
  color       = '#FFD700',
  description = 'Live matches from Chinese sports platform',
  config      = '{"source":"chinalive"}'
WHERE slug = 'china-live';

UPDATE tabs SET
  icon        = '📡',
  color       = '#60A5FA',
  description = 'Alternative streaming sources',
  config      = '{"source":"loungsan"}'
WHERE slug = 'loungsan';

UPDATE tabs SET
  icon        = '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
  color       = '#93C5FD',
  description = 'English commentary matches',
  config      = '{"source":"english","manual":true}'
WHERE slug = 'english';

CREATE TABLE IF NOT EXISTS app_config (
  key        VARCHAR(255) PRIMARY KEY,
  value      JSONB        NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

INSERT INTO app_config (key, value) VALUES
  ('features', '{
    "multiSourceBadge": true,
    "tvPage":           true,
    "searchBar":        true,
    "highlights":       false,
    "adminPanel":       false
  }'),
  ('ui', '{
    "appName":     "StreamZone",
    "theme":       "dark",
    "accentColor": "#00FF87",
    "bgColor":     "#0A0E1A",
    "defaultTab":  "main-live"
  }'),
  ('limits', '{
    "mainLiveLimit":  10,
    "matchCacheTTL":  30,
    "tabCacheTTL":    60,
    "configCacheTTL": 60
  }')
ON CONFLICT (key) DO NOTHING;
