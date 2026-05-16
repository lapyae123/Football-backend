-- TV & Radio channels table
CREATE TABLE IF NOT EXISTS tv_channels (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  slug        VARCHAR(100) UNIQUE NOT NULL,
  type        VARCHAR(10)  NOT NULL DEFAULT 'tv' CHECK (type IN ('tv', 'radio')),
  category    VARCHAR(100) NOT NULL DEFAULT 'General',
  emoji       VARCHAR(20)  NOT NULL DEFAULT '📺',
  color       VARCHAR(20)  NOT NULL DEFAULT '#00FF87',
  logo_url    TEXT,
  stream_url  TEXT,
  is_active   BOOLEAN      NOT NULL DEFAULT true,
  position    INTEGER      NOT NULL DEFAULT 0,
  country     VARCHAR(50)  DEFAULT 'Myanmar',
  language    VARCHAR(50)  DEFAULT 'Burmese',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tv_channels_type     ON tv_channels(type);
CREATE INDEX IF NOT EXISTS idx_tv_channels_active   ON tv_channels(is_active);
CREATE INDEX IF NOT EXISTS idx_tv_channels_position ON tv_channels(position);

-- ── TV channels ───────────────────────────────────────────────────────────────
INSERT INTO tv_channels (name, slug, type, category, emoji, color, position) VALUES
  -- Myanmar TV
  ('MRTV',            'mrtv',            'tv', 'Myanmar TV',  '📺', '#c1121f', 1),
  ('MRTV-4',          'mrtv4',           'tv', 'Myanmar TV',  '🎬', '#457b9d', 2),
  ('Myawady TV',      'myawady',         'tv', 'Myanmar TV',  '⭐', '#2a9d8f', 3),
  ('Channel 7',       'channel7',        'tv', 'Myanmar TV',  '7️⃣', '#e76f51', 4),
  ('Channel 9',       'channel9',        'tv', 'Myanmar TV',  '9️⃣', '#f4a261', 5),
  ('5 Plus',          '5plus',           'tv', 'Myanmar TV',  '5️⃣', '#8338ec', 6),
  ('DVB',             'dvb',             'tv', 'Myanmar TV',  '📡', '#3a86ff', 7),
  ('MITV',            'mitv',            'tv', 'Myanmar TV',  '📱', '#fb5607', 8),
  ('MWD Documentary', 'mwd-documentary', 'tv', 'Myanmar TV',  '🎞', '#6d6875', 9),
  ('MNTV',            'mntv',            'tv', 'Myanmar TV',  '🏛', '#386641', 10),
  ('NRC Channel',     'nrc',             'tv', 'Myanmar TV',  '📻', '#bc4749', 11),
  ('Reader Channel',  'reader',          'tv', 'Myanmar TV',  '📖', '#a7c957', 12),
  ('Maharbawdi',      'maharbawdi',      'tv', 'Myanmar TV',  '🎭', '#bc6c25', 13),
  -- Sports TV
  ('ESPN',            'espn',            'tv', 'Sports TV',   '🏆', '#e63946', 20),
  ('beIN Sports 1',   'bein1',           'tv', 'Sports TV',   '⚽', '#06aed5', 21),
  ('beIN Sports 2',   'bein2',           'tv', 'Sports TV',   '⚽', '#0096c7', 22),
  ('Sky Sports',      'sky-sports',      'tv', 'Sports TV',   '🔵', '#0077b6', 23),
  ('DAZN',            'dazn',            'tv', 'Sports TV',   '🎯', '#f72585', 24),
  -- News TV
  ('CNN',             'cnn',             'tv', 'News TV',     '🌍', '#cc0000', 30),
  ('BBC News',        'bbc-news',        'tv', 'News TV',     '🎙', '#bb1919', 31),
  ('Al Jazeera',      'al-jazeera',      'tv', 'News TV',     '📡', '#00843d', 32),
  ('Bloomberg',       'bloomberg',       'tv', 'News TV',     '📊', '#f4a000', 33)
ON CONFLICT (slug) DO NOTHING;

-- ── Radio channels ────────────────────────────────────────────────────────────
INSERT INTO tv_channels (name, slug, type, category, emoji, color, position) VALUES
  -- Myanmar Radio
  ('Shwe FM',         'shwe-fm',         'radio', 'Myanmar Radio', '📻', '#f4a000', 1),
  ('Mandalay FM',     'mandalay-fm',     'radio', 'Myanmar Radio', '📻', '#e63946', 2),
  ('City FM',         'city-fm',         'radio', 'Myanmar Radio', '📻', '#06aed5', 3),
  ('Cherry FM',       'cherry-fm',       'radio', 'Myanmar Radio', '📻', '#ff0a54', 4),
  ('Padamyar FM',     'padamyar-fm',     'radio', 'Myanmar Radio', '📻', '#3a86ff', 5),
  ('Ayeyarwady FM',   'ayeyarwady-fm',   'radio', 'Myanmar Radio', '📻', '#00b4d8', 6),
  ('MRTV Radio',      'mrtv-radio',      'radio', 'Myanmar Radio', '📻', '#c1121f', 7),
  ('Pyinsawaddy FM',  'pyinsawaddy-fm',  'radio', 'Myanmar Radio', '📻', '#8338ec', 8),
  -- News Radio
  ('RFA Burmese',     'rfa-burmese',     'radio', 'News Radio',   '🌏', '#457b9d', 10),
  ('DVB Radio',       'dvb-radio',       'radio', 'News Radio',   '📡', '#3a86ff', 11),
  ('BBC Burmese',     'bbc-burmese',     'radio', 'News Radio',   '🎙', '#bb1919', 12)
ON CONFLICT (slug) DO NOTHING;
