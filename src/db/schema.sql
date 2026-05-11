-- Football Live Streaming Aggregator Database Schema

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tabs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    position INT NOT NULL,
    source_type VARCHAR(50) NOT NULL,
    base_domain VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    driver_type VARCHAR(50) NOT NULL,
    base_domain VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    health_score INT DEFAULT 100,
    last_checked TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tab_id UUID REFERENCES tabs(id) ON DELETE CASCADE,
    title VARCHAR(500) NOT NULL,
    home_team VARCHAR(255) NOT NULL,
    away_team VARCHAR(255) NOT NULL,
    home_logo VARCHAR(500),
    away_logo VARCHAR(500),
    status VARCHAR(50) NOT NULL DEFAULT 'scheduled',
    scheduled_at TIMESTAMPTZ,
    source_match_id VARCHAR(255),
    source_name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stream_urls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id UUID REFERENCES matches(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    quality VARCHAR(10) NOT NULL,
    source_name VARCHAR(255),
    priority INT DEFAULT 1,
    is_healthy BOOLEAN DEFAULT true,
    last_checked TIMESTAMPTZ,
    fail_count INT DEFAULT 0,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE matches ADD COLUMN IF NOT EXISTS score_home SMALLINT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS score_away SMALLINT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS elapsed_minutes SMALLINT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS league VARCHAR(255);

ALTER TABLE stream_urls ADD COLUMN IF NOT EXISTS latency_ms INTEGER;

-- Remove duplicate stream URLs (same base URL, different auth_key), keep newest per match
DELETE FROM stream_urls
WHERE id IN (
  SELECT a.id
  FROM stream_urls a
  JOIN stream_urls b
    ON  a.match_id = b.match_id
    AND split_part(a.url, '?', 1) = split_part(b.url, '?', 1)
    AND a.created_at < b.created_at
);

-- Team logos keyed by normalised team name (lowercase, no spaces/punctuation)
-- logo_url should point to a stable CDN (e.g. Wikipedia/Wikimedia) — no hotlink issues
CREATE TABLE IF NOT EXISTS team_logos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_name VARCHAR(255) NOT NULL,          -- display name e.g. "Manchester United"
    team_key  VARCHAR(255) UNIQUE NOT NULL,   -- normalised key e.g. "manchesterunited"
    logo_url  VARCHAR(500) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_logos_key ON team_logos(team_key);

CREATE INDEX IF NOT EXISTS idx_tabs_slug ON tabs(slug);
CREATE INDEX IF NOT EXISTS idx_matches_tab_id ON matches(tab_id);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_scheduled_at ON matches(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_stream_urls_match_id ON stream_urls(match_id);
CREATE INDEX IF NOT EXISTS idx_stream_urls_is_healthy ON stream_urls(is_healthy);
CREATE INDEX IF NOT EXISTS idx_sources_driver_type ON sources(driver_type);

INSERT INTO tabs (id, name, slug, position, source_type, is_active)
VALUES
  (gen_random_uuid(), 'Main Live', 'main-live', 1, 'api', true),
  (gen_random_uuid(), 'SOCO Live', 'soco-live', 2, 'scraper', true),
  (gen_random_uuid(), 'China Live', 'china-live', 3, 'scraper', true),
  (gen_random_uuid(), 'Loungsan', 'loungsan', 4, 'scraper', true),
  (gen_random_uuid(), 'English', 'english', 5, 'api', true)
ON CONFLICT (slug) DO NOTHING;

-- ─── Config-driven architecture ───────────────────────────────────────────────

ALTER TABLE tabs ADD COLUMN IF NOT EXISTS icon        VARCHAR(30)  DEFAULT '⚽';
ALTER TABLE tabs ADD COLUMN IF NOT EXISTS color       VARCHAR(20)  DEFAULT '#00FF87';
ALTER TABLE tabs ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE tabs ADD COLUMN IF NOT EXISTS config      JSONB        NOT NULL DEFAULT '{}';

UPDATE tabs SET icon = '⚡',  color = '#00FF87', description = 'Top live matches from all sources',
  config = '{"aggregates":["soco-live","china-live","loungsan"],"maxMatches":10}'
  WHERE slug = 'main-live';
UPDATE tabs SET icon = '🔴',  color = '#FF4444', description = 'Live matches from SocoLive.tv',
  config = '{"source":"socolive"}'
  WHERE slug = 'soco-live';
UPDATE tabs SET icon = '🇨🇳', color = '#FFD700', description = 'Live matches from Chinese sports platform',
  config = '{"source":"chinalive"}'
  WHERE slug = 'china-live';
UPDATE tabs SET icon = '📡',  color = '#60A5FA', description = 'Alternative streaming sources',
  config = '{"source":"loungsan"}'
  WHERE slug = 'loungsan';
UPDATE tabs SET icon = '🏴󠁧󠁢󠁥󠁮󠁧󠁿', color = '#93C5FD', description = 'English commentary matches',
  config = '{"source":"english","manual":true}'
  WHERE slug = 'english';

-- Global key/value store — drives feature flags and UI config sent to the frontend
CREATE TABLE IF NOT EXISTS app_config (
  key        VARCHAR(255) PRIMARY KEY,
  value      JSONB        NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

INSERT INTO app_config (key, value) VALUES
  ('features', '{
    "multiSourceBadge": true,
    "tvPage":          true,
    "searchBar":       true,
    "highlights":      false,
    "adminPanel":      false
  }'),
  ('ui', '{
    "appName":      "StreamZone",
    "theme":        "dark",
    "accentColor":  "#00FF87",
    "bgColor":      "#0A0E1A",
    "defaultTab":   "main-live"
  }'),
  ('limits', '{
    "mainLiveLimit":   10,
    "matchCacheTTL":   30,
    "tabCacheTTL":     60,
    "configCacheTTL":  60
  }')
ON CONFLICT (key) DO NOTHING;
