/*
 * Camada de acesso ao banco de dados SQLite para o Debate Taquara Raiz.
 *
 * Este módulo centraliza todas as operações de leitura e escrita no banco
 * `database.db`, permitindo que o servidor HTTP (server.js) possa ser
 * refatorado para buscar informações diretamente das tabelas. As funções
 * retornam Promises, facilitando o uso com async/await.
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Caminho para o arquivo de banco (assume que database.db está na pasta website)
const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath);

// Consulta todos os usuários
function getUsers() {
  return new Promise((resolve, reject) => {
    db.all('SELECT id, name, email, password, isAdmin FROM users', [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Obtém um usuário pelo e‑mail e senha (útil para login)
function getUserByCredentials(email, password) {
  return new Promise((resolve, reject) => {
    db.get('SELECT id, name, email, password, isAdmin FROM users WHERE email = ? AND password = ?', [email, password], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// Obtém usuário por ID
function getUserById(userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT id, name, email, password, isAdmin FROM users WHERE id = ?', [userId], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// Consulta todos os times
function getTeams() {
  return new Promise((resolve, reject) => {
    db.all('SELECT id, name, abbr, highlight FROM teams ORDER BY id', [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Obtém informações de um time específico
function getTeamById(teamId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT id, name, abbr, highlight FROM teams WHERE id = ?', [teamId], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// Consulta a classificação completa (sem ordenação específica)
function getClassification() {
  return new Promise((resolve, reject) => {
    db.all('SELECT team_id, points, games, wins, draws, losses, goals_for, goals_against, goal_diff FROM classification', [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Atualiza a classificação: recebe um array de objetos e persiste cada registro.
async function updateClassification(entries) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('INSERT OR REPLACE INTO classification (team_id, points, games, wins, draws, losses, goals_for, goals_against, goal_diff) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    db.serialize(() => {
      for (const e of entries) {
        stmt.run([e.team_id, e.points, e.games, e.wins, e.draws, e.losses, e.goals_for, e.goals_against, e.goal_diff]);
      }
      stmt.finalize((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

// Consulta todos os jogos (partidas)
function getMatches() {
  return new Promise((resolve, reject) => {
    db.all('SELECT id, round, date, home_team_id, away_team_id, home_score, away_score FROM matches ORDER BY date', [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Consulta partidas por rodada
function getMatchesByRound(round) {
  return new Promise((resolve, reject) => {
    db.all('SELECT id, round, date, home_team_id, away_team_id, home_score, away_score FROM matches WHERE round = ? ORDER BY date', [round], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Atualiza o placar de uma partida específica
function updateMatchScore(matchId, homeScore, awayScore) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE matches SET home_score = ?, away_score = ? WHERE id = ?', [homeScore, awayScore, matchId], function(err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Consulta todos os palpites
function getPredictions() {
  return new Promise((resolve, reject) => {
    db.all('SELECT id, match_id, user_id, home_score, away_score FROM predictions', [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Obtém palpites por partida
function getPredictionsByMatch(matchId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT id, match_id, user_id, home_score, away_score FROM predictions WHERE match_id = ?', [matchId], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Obtém palpites por rodada (join com matches)
function getPredictionsByRound(round) {
  return new Promise((resolve, reject) => {
    const sql = `SELECT p.id, p.match_id, p.user_id, p.home_score, p.away_score
                 FROM predictions p
                 JOIN matches m ON p.match_id = m.id
                 WHERE m.round = ?`;
    db.all(sql, [round], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Insere ou substitui um palpite
function upsertPrediction(prediction) {
  return new Promise((resolve, reject) => {
    const { id, match_id, user_id, home_score, away_score } = prediction;
    if (id === undefined || id === null) {
      // Insere nova linha sem especificar o ID (ID será atribuído automaticamente)
      db.run(
        'INSERT INTO predictions (match_id, user_id, home_score, away_score) VALUES (?, ?, ?, ?)',
        [match_id, user_id, home_score, away_score],
        function (err) {
          if (err) reject(err);
          else resolve();
        }
      );
    } else {
      db.run(
        'INSERT OR REPLACE INTO predictions (id, match_id, user_id, home_score, away_score) VALUES (?, ?, ?, ?, ?)',
        [id, match_id, user_id, home_score, away_score],
        function (err) {
          if (err) reject(err);
          else resolve();
        }
      );
    }
  });
}

// Salva todos os palpites de um usuário para uma rodada. Remove palpites antigos dessa rodada e insere os novos.
async function savePredictionsForRound(round, userId, predictionsList) {
  // predictionsList: array of objects {match_id, home_score, away_score}
  await deletePredictionsForRoundAndUser(round, userId);
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('INSERT INTO predictions (match_id, user_id, home_score, away_score) VALUES (?, ?, ?, ?)');
    db.serialize(() => {
      for (const p of predictionsList) {
        stmt.run([p.match_id, userId, p.home_score, p.away_score]);
      }
      stmt.finalize(err => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

// Remove palpites de um usuário para uma determinada rodada
function deletePredictionsForRoundAndUser(round, userId) {
  return new Promise((resolve, reject) => {
    const sql = `DELETE FROM predictions
                 WHERE user_id = ? AND match_id IN (SELECT id FROM matches WHERE round = ?)`;
    db.run(sql, [userId, round], function(err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Consulta artilharia
function getScorers() {
  return new Promise((resolve, reject) => {
    db.all('SELECT id, player, team_id, goals, rank FROM scorers ORDER BY rank', [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Atualiza artilharia: substitui todos os registros
async function updateScorers(scorerList) {
  return new Promise((resolve, reject) => {
    // Primeiro remove todos os registros
    db.serialize(() => {
      db.run('DELETE FROM scorers', [], (err) => {
        if (err) return reject(err);
        const stmt = db.prepare('INSERT INTO scorers (id, player, team_id, goals, rank) VALUES (?, ?, ?, ?, ?)');
        for (const s of scorerList) {
          const scorerId = s.id || s.rank;
          stmt.run([scorerId, s.player, s.team_id, s.goals, s.rank]);
        }
        stmt.finalize((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  });
}

module.exports = {
  db,
  getUsers,
  getUserByCredentials,
  getUserById,
  getTeams,
  getTeamById,
  getClassification,
  updateClassification,
  getMatches,
  getMatchesByRound,
  updateMatchScore,
  getPredictions,
  getPredictionsByMatch,
  getPredictionsByRound,
  upsertPrediction,
  deletePredictionsForRoundAndUser,
  getScorers,
  updateScorers,
  savePredictionsForRound
};