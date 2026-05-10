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
