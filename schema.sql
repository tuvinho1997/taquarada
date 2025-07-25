-- Definição das tabelas para o banco SQLite do Debate Taquara Raiz

-- Usuários: somente o administrador precisa efetuar login. Os apresentadores não
-- possuem email e senha para login, mas permanecem na tabela para cálculos de ranking.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  password TEXT,
  isAdmin INTEGER NOT NULL
);

-- Times participantes da Série B 2025
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  abbr TEXT NOT NULL,
  highlight INTEGER NOT NULL
);

-- Partidas disputadas e programadas. Os campos home_score e away_score ficam
-- nulos para jogos futuros. A data é armazenada em texto (ISO-8601).
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY,
  round INTEGER NOT NULL,
  date TEXT NOT NULL,
  home_team_id INTEGER NOT NULL,
  away_team_id INTEGER NOT NULL,
  home_score INTEGER,
  away_score INTEGER
);

-- Palpites feitos pelos apresentadores. Cada registro corresponde ao palpite
-- de um apresentador (user_id) para uma partida (match_id).
CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  home_score INTEGER NOT NULL,
  away_score INTEGER NOT NULL
);

-- Classificação acumulada da competição. Pode ser calculada ou atualizada
-- manualmente via área de administração.
CREATE TABLE IF NOT EXISTS classification (
  team_id INTEGER PRIMARY KEY,
  points INTEGER,
  games INTEGER,
  wins INTEGER,
  draws INTEGER,
  losses INTEGER,
  goals_for INTEGER,
  goals_against INTEGER,
  goal_diff INTEGER
);

-- Artilharia: jogadores, seus times, gols marcados e classificação por rank.
CREATE TABLE IF NOT EXISTS scorers (
  id INTEGER PRIMARY KEY,
  player TEXT NOT NULL,
  team_id INTEGER NOT NULL,
  goals INTEGER,
  rank INTEGER
);