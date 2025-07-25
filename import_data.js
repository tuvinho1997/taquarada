/*
 * Script de importação de dados para o banco SQLite.
 *
 * Este script lê os arquivos JSON existentes em `data/` (teams, matches,
 * users, predictions, scorers e classification) e insere/atualiza esses
 * registros nas tabelas correspondentes da base SQLite. Execute-o uma vez
 * após rodar init_db.js para popular o banco com os dados iniciais.
 */

const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

// Caminhos
const dbFile = path.join(__dirname, 'database.db');
const dataDir = path.join(__dirname, 'data');

// Abre o banco
const db = new sqlite3.Database(dbFile);

// Carrega dados JSON
function loadJSON(filename) {
  const filePath = path.join(dataDir, filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const teams = loadJSON('teams.json');
const matches = loadJSON('matches.json');
const users = loadJSON('users.json');
const predictions = loadJSON('predictions.json');
const scorers = loadJSON('scorers.json');
const classification = loadJSON('classification.json');

// Função utilitária para aguardar a conclusão de todas as execuções
function runInsert(stmt, params) {
  return new Promise((resolve, reject) => {
    stmt.run(params, function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function importData() {
  try {
    // Desliga verificação de integridade temporariamente para acelerar inserts
    await new Promise((resolve, reject) => {
      db.exec('PRAGMA foreign_keys = OFF;', (err) => (err ? reject(err) : resolve()));
    });

    // Users
    const userStmt = db.prepare('INSERT OR REPLACE INTO users (id, name, email, password, isAdmin) VALUES (?, ?, ?, ?, ?)');
    for (const u of users) {
      await runInsert(userStmt, [u.id, u.name, u.email, u.password, u.isAdmin ? 1 : 0]);
    }
    userStmt.finalize();

    // Teams
    const teamStmt = db.prepare('INSERT OR REPLACE INTO teams (id, name, abbr, highlight) VALUES (?, ?, ?, ?)');
    for (const t of teams) {
      await runInsert(teamStmt, [t.id, t.name, t.abbr, t.highlight ? 1 : 0]);
    }
    teamStmt.finalize();

    // Matches
    const matchStmt = db.prepare('INSERT OR REPLACE INTO matches (id, round, date, home_team_id, away_team_id, home_score, away_score) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const m of matches) {
      await runInsert(matchStmt, [m.id, m.round, m.date, m.home_team_id, m.away_team_id, m.home_score, m.away_score]);
    }
    matchStmt.finalize();

    // Predictions
    const predStmt = db.prepare('INSERT OR REPLACE INTO predictions (id, match_id, user_id, home_score, away_score) VALUES (?, ?, ?, ?, ?)');
    for (const p of predictions) {
      await runInsert(predStmt, [p.id, p.match_id, p.user_id, p.home_score, p.away_score]);
    }
    predStmt.finalize();

    // Scorers (usa o campo rank como id para manter consistência)
    const scorerStmt = db.prepare('INSERT OR REPLACE INTO scorers (id, player, team_id, goals, rank) VALUES (?, ?, ?, ?, ?)');
    for (const s of scorers) {
      const scorerId = s.rank || s.id;
      await runInsert(scorerStmt, [scorerId, s.player, s.team_id, s.goals, s.rank]);
    }
    scorerStmt.finalize();

    // Classification
    const classStmt = db.prepare('INSERT OR REPLACE INTO classification (team_id, points, games, wins, draws, losses, goals_for, goals_against, goal_diff) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const c of classification) {
      await runInsert(classStmt, [c.team_id, c.points, c.games, c.wins, c.draws, c.losses, c.goals_for, c.goals_against, c.goal_diff]);
    }
    classStmt.finalize();

    console.log('Dados importados com sucesso!');
  } catch (err) {
    console.error('Erro ao importar dados:', err.message);
  } finally {
    db.close();
  }
}

importData();