const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const querystring = require('querystring');
const crypto = require('crypto');
// Importa camada de acesso ao banco de dados. Esta camada fornece funçõess
// assíncronas para consultar e manipular registros no SQLite. Atualmente
// apenas algumas rotas utilizam essas funções diretamente; a refatoração
// completa para o banco pode ser feita posteriormente.
const dbAccess = require('./database');

// IDs de partidas que não devem ser considerados em palpites e ranking. Estes
// jogos permanecem no histórico de resultados, mas não devem aparecer na
// página de palpites nem contar pontos no ranking. A lista é definida
// conforme decisão do administrador (por exemplo, jogos anulados na rodada 18).
const excludedMatchIds = new Set([5, 6, 7, 8]);

// Commit atualizado 28/07/2025
// Mapeamento de cores para cada equipe. Cada sigla recebe uma cor distinta
// para representar visualmente o time por meio de um círculo colorido. As
// cores foram escolhidas manualmente e podem ser ajustadas conforme
// preferências estéticas do portal.
const teamColors = {
  GOI: '#FF6B6B', // Goiás
  CFC: '#6BCB77', // Coritiba
  NOV: '#4D96FF', // Novorizontino
  CHA: '#FFD93D', // Chapecoense
  CUI: '#FF6F91', // Cuiabá
  VNO: '#845EC2', // Vila Nova
  REM: '#FFC75F', // Remo
  AVA: '#008F7A', // Avaí
  CAP: '#2C73D2', // Athletico-PR
  CRI: '#C34A36', // Criciúma
  ATH: '#FF9671', // Athletic Club
  OPE: '#00C9A7', // Operário
  CRB: '#C1D3FE', // CRB
  ACG: '#B8C4FF', // Atlético-GO
  AME: '#FFD6E0', // América-MG
  PAY: '#FFC700', // Paysandu
  FER: '#8FB339', // Ferroviária
  AMA: '#E36414', // Amazonas
  VOL: '#6F4E37', // Volta Redonda
  BFC: '#A3CB38'  // Botafogo-SP
};

/**
 * Retorna um span HTML contendo um pequeno círculo colorido (dot) para
 * representar uma equipe. O tamanho do dot é definido pelo parâmetro
 * `small`. Caso a sigla da equipe não esteja no mapeamento, utiliza a
 * cor amarela padrão.
 *
 * @param {Object} team - Objeto da equipe, contendo ao menos a propriedade
 *                        `abbr`.
 * @param {boolean} small - Se verdadeiro, usa a classe `.small-dot` ao
 *                          invés de `.team-dot`.
 * @returns {string} HTML com a marcação do dot colorido.
 */
// Retorna a marca visual para uma equipe. Em vez de apenas um ponto colorido,
// utilizamos o escudo (logo) da equipe sempre que possível. O tamanho da
// imagem varia de acordo com o parâmetro `small` para que se ajuste
// corretamente em listas compactas (como nas tabelas de artilheiros e
// resultados). Caso a sigla da equipe não esteja definida ou não exista um
// arquivo de logotipo correspondente, o código volta a utilizar um ponto
// colorido como reserva. O nome da equipe é incluído no atributo `alt` para
// acessibilidade.
function getTeamDot(team, small = false) {
  const abbr = (team.abbr || '').toLowerCase();
  const className = small ? 'team-logo-small' : 'team-logo';
  // Verifica se há um logotipo correspondente no diretório de logos.
  // Se não houver, usa o ponto colorido como fallback.
  const logoPath = `/static/team_logos/${abbr}.png`;
  // Construir o elemento <img> para o logotipo. Não fazemos verificação de
  // existência em tempo de execução; assumimos que os arquivos estão
  // disponíveis para todas as equipes cadastradas. Se algum arquivo
  // estiver ausente, o navegador exibirá o ícone de erro padrão.
  return `<img src="${logoPath}" class="${className}" alt="${team.name} logo">`;
}

// Helper functions to load and persist JSON data
const dataDir = path.join(__dirname, 'data');
function readJSON(filename) {
  const p = path.join(dataDir, filename);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function writeJSON(filename, data) {
  const p = path.join(dataDir, filename);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

// Load all data into memory (will be re-read when needed)
function loadData() {
  return {
    users: readJSON('users.json'),
    matches: readJSON('matches.json'),
    teams: readJSON('teams.json'),
    classification: readJSON('classification.json'),
    predictions: readJSON('predictions.json'),
    scorers: readJSON('scorers.json')
  };
}

// Session store: token -> userId
const sessions = {};

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(function(cookie) {
    const parts = cookie.split('=');
    const key = parts.shift().trim();
    const value = decodeURIComponent(parts.join('='));
    list[key] = value;
  });
  return list;
}

function getUserFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.session;
  if (token && sessions[token]) {
    const data = loadData();
    return data.users.find(u => u.id === sessions[token]);
  }
  return null;
}

// Render template with simple variable substitution
function renderTemplate(templateName, vars) {
  const templatePath = path.join(__dirname, 'templates', templateName);
  let template = fs.readFileSync(templatePath, 'utf8');
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, p1) => {
    return vars[p1] !== undefined ? vars[p1] : '';
  });
}

function sendRedirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.end();
}

function handleStatic(req, res, pathname) {
  const filePath = path.join(__dirname, pathname);
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    // Set content type based on extension
    const ext = path.extname(filePath);
    let type = 'text/plain';
    if (ext === '.css') type = 'text/css';
    else if (ext === '.js') type = 'application/javascript';
    else if (['.png', '.jpg', '.jpeg', '.gif'].includes(ext)) type = 'image/' + ext.substring(1);
    else if (ext === '.svg') type = 'image/svg+xml';
    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    res.end(content);
  });
}

// Compute the last 5 results (V, E, D) for a team based on finished matches
function computeTeamForm(teamId, matches) {
  // Filter only finished matches where this team played
  const finished = matches.filter(m => {
    return m.home_score !== null && m.away_score !== null &&
      (m.home_team_id === teamId || m.away_team_id === teamId);
  });
  // Order by date descending
  finished.sort((a, b) => {
    const da = new Date(a.date);
    const db = new Date(b.date);
    return db - da;
  });
  const form = [];
  // Determine result from the perspective of the team
  finished.slice(0, 5).forEach(m => {
    let result;
    if (m.home_team_id === teamId) {
      if (m.home_score > m.away_score) result = 'V';
      else if (m.home_score < m.away_score) result = 'D';
      else result = 'E';
    } else {
      // team played as visitor
      if (m.away_score > m.home_score) result = 'V';
      else if (m.away_score < m.home_score) result = 'D';
      else result = 'E';
    }
    form.push(result);
  });
  // Fill remaining positions with dash
  while (form.length < 5) form.push('-');
  return form;
}

/**
 * Aplica as estatísticas de um confronto à classificação de um time.
 * Quando `add` é verdadeiro, soma os valores; quando falso, subtrai.
 *
 * @param {Object} entry Objeto de classificação do time (será modificado).
 * @param {number} goalsFor Gols marcados pelo time nesse confronto.
 * @param {number} goalsAgainst Gols sofridos pelo time nesse confronto.
 * @param {boolean} add Se verdadeiro, adiciona; se falso, remove.
 */
function applyMatchStats(entry, goalsFor, goalsAgainst, add = true) {
  const sign = add ? 1 : -1;
  entry.games += 1 * sign;
  entry.goals_for += goalsFor * sign;
  entry.goals_against += goalsAgainst * sign;
  if (goalsFor > goalsAgainst) {
    entry.wins += 1 * sign;
    entry.points += 3 * sign;
  } else if (goalsFor < goalsAgainst) {
    entry.losses += 1 * sign;
    // derrota não adiciona pontos
  } else {
    entry.draws += 1 * sign;
    entry.points += 1 * sign;
  }
}

/**
 * Atualiza a classificação existente a partir das diferenças entre duas
 * listas de partidas (antes e depois). Para cada partida cujo placar
 * tenha sido alterado (de null para um número, de um valor para outro
 * ou vice-versa), remove os efeitos do placar antigo e adiciona os
 * efeitos do placar novo. As partidas sem alteração de placar são
 * ignoradas.
 *
 * @param {Array} classification Lista de classificações atuais
 * @param {Array} oldMatches Lista de partidas antes da atualização
 * @param {Array} newMatches Lista de partidas após a atualização
 * @returns {Array} Nova lista de classificações atualizada
 */
function updateClassificationFromMatchChanges(classification, oldMatches, newMatches) {
  // Converte classificação em mapa para alteração rápida
  const map = {};
  classification.forEach(entry => {
    // Faz uma cópia para não modificar o original diretamente
    map[entry.team_id] = { ...entry };
  });
  // Itera sobre as partidas antigas e novas simultaneamente
  oldMatches.forEach((oldMatch) => {
    // Encontra a partida correspondente na nova lista
    const newMatch = newMatches.find(m => m.id === oldMatch.id);
    if (!newMatch) return;
    const oldHS = oldMatch.home_score;
    const oldAS = oldMatch.away_score;
    const newHS = newMatch.home_score;
    const newAS = newMatch.away_score;
    // Se o placar não mudou, nada a fazer
    if (oldHS === newHS && oldAS === newAS) {
      return;
    }
    // Remove estatísticas do placar antigo (se existia)
    if (oldHS !== null && oldAS !== null) {
      applyMatchStats(map[oldMatch.home_team_id], oldHS, oldAS, false);
      applyMatchStats(map[oldMatch.away_team_id], oldAS, oldHS, false);
    }
    // Adiciona estatísticas do novo placar (se existe)
    if (newHS !== null && newAS !== null) {
      applyMatchStats(map[newMatch.home_team_id], newHS, newAS, true);
      applyMatchStats(map[newMatch.away_team_id], newAS, newHS, true);
    }
  });
  // Recalcula saldo de gols
  Object.values(map).forEach(entry => {
    entry.goal_diff = entry.goals_for - entry.goals_against;
  });
  return Object.values(map);
}

/**
 * Gera automaticamente a classificação da Série B com base nos
 * resultados das partidas finalizadas. A função considera todas
 * as equipes cadastradas e percorre a lista de confrontos para
 * acumular partidas, vitórias, empates, derrotas, gols pró e
 * contra. Empates valem 1 ponto e vitórias 3 pontos. Partidas
 * sem placares (home_score ou away_score nulos) são ignoradas.
 *
 * O array resultante é ordenado de forma decrescente pelos
 * critérios usuais: pontos, vitórias, saldo de gols, gols pró e
 * ordem alfabética do nome do time para desempate final. Esta
 * ordenação garante que a tabela exibida na página inicial
 * reflita a situação real do campeonato sem depender de edição
 * manual.
 *
 * @param {Array} teams Lista de equipes cadastradas
 * @param {Array} matches Lista de partidas, contendo placares
 * @returns {Array} Nova lista de objetos de classificação
 */
function computeClassification(teams, matches) {
  // Inicializa um mapa para acumular estatísticas de cada time
  const map = {};
  teams.forEach(team => {
    map[team.id] = {
      team_id: team.id,
      points: 0,
      games: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      goals_for: 0,
      goals_against: 0,
      goal_diff: 0
    };
  });
  // Processa cada partida finalizada
  matches.forEach(match => {
    const hs = match.home_score;
    const as = match.away_score;
    // Ignora partidas que ainda não têm ambos os placares definidos
    if (hs === null || as === null) return;
    const homeStats = map[match.home_team_id];
    const awayStats = map[match.away_team_id];
    // Atualiza jogos e gols
    homeStats.games++;
    awayStats.games++;
    homeStats.goals_for += hs;
    homeStats.goals_against += as;
    awayStats.goals_for += as;
    awayStats.goals_against += hs;
    // Determina resultado e distribui pontos
    if (hs > as) {
      homeStats.wins++;
      homeStats.points += 3;
      awayStats.losses++;
    } else if (hs < as) {
      awayStats.wins++;
      awayStats.points += 3;
      homeStats.losses++;
    } else {
      homeStats.draws++;
      awayStats.draws++;
      homeStats.points += 1;
      awayStats.points += 1;
    }
  });
  // Calcula saldo de gols
  teams.forEach(team => {
    const stats = map[team.id];
    stats.goal_diff = stats.goals_for - stats.goals_against;
  });
  // Converte o mapa em lista e ordena pelos critérios de desempate
  const classification = Object.values(map);
  classification.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.goal_diff !== a.goal_diff) return b.goal_diff - a.goal_diff;
    if (b.goals_for !== a.goals_for) return b.goals_for - a.goals_for;
    // desempate por ordem alfabética do nome do time
    const teamA = teams.find(t => t.id === a.team_id);
    const teamB = teams.find(t => t.id === b.team_id);
    return teamA.name.localeCompare(teamB.name);
  });
  return classification;
}

// Determine result sign: returns 'home', 'draw', 'away'
function resultSign(home, away) {
  if (home > away) return 'home';
  if (home < away) return 'away';
  return 'draw';
}

function buildNavLinks(user) {
  let adminLink = '';
  let authLink = '';
  if (user && user.isAdmin) {
    adminLink = '<li><a href="/admin">Admin</a></li>';
  }
  if (user) {
    authLink = `<li><a href="/logout">Sair (${user.name})</a></li>`;
  } else {
    authLink = '<li><a href="/login">Entrar</a></li>';
  }
  return { adminLink, authLink };
}

function handleHome(req, res, user) {
  const data = loadData();
  // Ordena a classificação utilizando as estatísticas já armazenadas no arquivo
  // `classification.json`. Isso preserva as quantidades de jogos, vitórias,
  // empates e derrotas informadas externamente, mas exibe os clubes
  // na ordem correta (pontos, vitórias, saldo de gols, gols pró e nome).
  const sorted = data.classification.slice();
  sorted.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.goal_diff !== a.goal_diff) return b.goal_diff - a.goal_diff;
    if (b.goals_for !== a.goals_for) return b.goals_for - a.goals_for;
    const teamA = data.teams.find(t => t.id === a.team_id);
    const teamB = data.teams.find(t => t.id === b.team_id);
    return teamA.name.localeCompare(teamB.name);
  });
  // Build table rows
  let rows = '';
  sorted.forEach((entry, index) => {
    const team = data.teams.find(t => t.id === entry.team_id);
    const pos = index + 1;
    let zoneClass = '';
    if (pos <= 4) zoneClass = 'zone-promotion';
    else if (pos >= sorted.length - 3) zoneClass = 'zone-relegation';
    else zoneClass = 'zone-middle';
    const highlight = team.highlight ? 'highlight-team' : '';
    // Compute real form (last 5 results) for this team
    const form = computeTeamForm(entry.team_id, data.matches);
    const formHtml = form.map(result => {
      let cls = 'result-draw';
      if (result === 'V') cls = 'result-win';
      else if (result === 'D') cls = 'result-loss';
      else if (result === '-') cls = 'result-none';
      return `<span class="${cls}"></span>`;
    }).join('');
    // Monta representação do time com um ponto colorido ao invés de logotipo.
    // Isso garante visual consistente mesmo sem arquivos de escudo.
    const dot = getTeamDot(team);
    const teamLabel = `<div class="team-label">${dot}<span>${team.name}</span></div>`;
    rows += `<tr class="${zoneClass} ${highlight}"><td>${pos}</td>`+
            `<td>${teamLabel}</td>`+
            `<td>${entry.points}</td>`+
            `<td>${entry.games}</td>`+
            `<td>${entry.wins}</td>`+
            `<td>${entry.draws}</td>`+
            `<td>${entry.losses}</td>`+
            `<td>${entry.goals_for}</td>`+
            `<td>${entry.goals_against}</td>`+
            `<td>${entry.goal_diff >= 0 ? '+' + entry.goal_diff : entry.goal_diff}</td>`+
            `<td><div class="form-indicator">${formHtml}</div></td>`+
            `</tr>`;
  });
  const now = new Date().toISOString().split('T')[0];
  const nav = buildNavLinks(user);
  // Compute additional stats for hero cards
  // Determine the position of Criciúma (team marked with highlight flag)
  let criPosition = '--';
  for (let i = 0; i < sorted.length; i++) {
    const team = data.teams.find(t => t.id === sorted[i].team_id);
    if (team && team.highlight) {
      criPosition = (i + 1).toString();
      break;
    }
  }
  // Total number of matches stored (including finalizados e futuros)
  const totalMatches = data.matches.length.toString();
  const html = renderTemplate('home.html', {
    table_rows: rows,
    last_update: now,
    admin_link: nav.adminLink,
    auth_link: nav.authLink,
    criciuma_position: criPosition,
    total_matches: totalMatches
  });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
}

function handleLoginGet(req, res) {
  const html = renderTemplate('login.html', { message: '' });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
}

function handleLoginPost(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });
  req.on('end', () => {
    const parsed = querystring.parse(body);
    const email = parsed.email;
    const password = parsed.password;
    // Busca o usuário no banco de dados. O banco armazena somente
    // credenciais do administrador (demais perfis não fazem login).
    dbAccess.getUserByCredentials(email, password)
      .then((user) => {
        if (user && user.isAdmin) {
          const token = crypto.randomBytes(16).toString('hex');
          sessions[token] = user.id;
          res.setHeader('Set-Cookie', `session=${token}; HttpOnly`);
          sendRedirect(res, '/');
        } else {
          const html = renderTemplate('login.html', { message: 'Credenciais incorretas ou acesso não autorizado' });
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(html);
        }
      })
      .catch((err) => {
        console.error('Erro ao autenticar:', err.message);
        const html = renderTemplate('login.html', { message: 'Erro ao autenticar' });
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html);
      });
  });
}

function handleLogout(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.session) {
    delete sessions[cookies.session];
    res.setHeader('Set-Cookie', 'session=; expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  sendRedirect(res, '/');
}

function getNextRoundForUser(data, userId) {
  // Determine rounds with matches that have at least one undefined score
  const roundsWithOpen = new Set();
  data.matches.forEach(m => {
    if (m.home_score === null || m.away_score === null) {
      roundsWithOpen.add(m.round);
    }
  });
  const openRounds = Array.from(roundsWithOpen).sort((a, b) => a - b);
  if (openRounds.length === 0) return null;
  // For the smallest open round, check if user has predictions for all matches; if yes, skip to next open round
  for (const r of openRounds) {
    const roundMatches = data.matches.filter(m => m.round === r);
    let allPredicted = true;
    for (const match of roundMatches) {
      const pred = data.predictions.find(p => p.match_id === match.id && p.user_id === userId);
      if (!pred) {
        allPredicted = false;
        break;
      }
    }
    if (!allPredicted) {
      return r;
    }
  }
  return openRounds[0];
}

// Determine next round needing predictions across all presenters (non-admin users)
function getNextRoundForAll(data) {
  // Identify rounds with matches that have at least one undefined score (open rounds)
  const roundsWithOpen = new Set();
  data.matches.forEach(m => {
    // Ignora partidas excluídas de palpites
    if (excludedMatchIds.has(m.id)) return;
    if (m.home_score === null || m.away_score === null) {
      roundsWithOpen.add(m.round);
    }
  });
  const openRounds = Array.from(roundsWithOpen).sort((a, b) => a - b);
  if (openRounds.length === 0) return null;
  const presenters = data.users.filter(u => !u.isAdmin);
  // For each open round, check if all presenters predicted all matches; if not, return this round
  for (const r of openRounds) {
    // Seleciona apenas partidas que não estão na lista de exclusão
    const roundMatches = data.matches.filter(m => m.round === r && !excludedMatchIds.has(m.id));
    let allPredicted = true;
    for (const match of roundMatches) {
      for (const p of presenters) {
        const pred = data.predictions.find(pr => pr.match_id === match.id && pr.user_id === p.id);
        if (!pred) {
          allPredicted = false;
          break;
        }
      }
      if (!allPredicted) break;
    }
    if (!allPredicted) return r;
  }
  // If all open rounds have all predictions, return the smallest open round to allow edits
  return openRounds[0];
}

function handlePalpitesGet(req, res, user) {
  const data = loadData();
  const nextRound = getNextRoundForAll(data);
  // Verifica se existe um parâmetro saved=1 na query string para exibir mensagem de sucesso
  const parsedUrl = url.parse(req.url, true);
  const message = parsedUrl.query.saved ? 'Palpites salvos com sucesso!' : '';
  // Constrói HTML de mensagem de sucesso somente se houver mensagem
  let messageHtml = '';
  if (message) {
    messageHtml = `<div class="success-message"><span class="success-icon">✅</span><span>${message}</span></div>`;
  }
  if (!nextRound) {
    // Não há rodadas futuras para palpite
    const html = renderTemplate('palpites.html', {
      table_head: '<tr><th>Confronto</th></tr>',
      match_rows: '<tr><td colspan="10">Nenhum jogo pendente para palpite.</td></tr>',
      round_number: '-',
      message_html: '',
      admin_link: '',
      user_name: user.name
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
    return;
  }
  // Filtra apenas jogos da rodada que não estão excluídos de palpites
  const matches = data.matches.filter(m => m.round === nextRound && !excludedMatchIds.has(m.id));
  const presenters = data.users.filter(u => !u.isAdmin);
  // Cabeçalho da tabela (duas linhas)
  let headRow1 = '<tr><th rowspan="2">Confronto</th>';
  presenters.forEach(p => {
    headRow1 += `<th colspan="3">${p.name}</th>`;
  });
  headRow1 += '</tr>';
  let headRow2 = '<tr>';
  presenters.forEach(() => {
    headRow2 += '<th>P.Casa</th><th>P.Fora</th><th>Res</th>';
  });
  headRow2 += '</tr>';
  const tableHead = headRow1 + headRow2;
  // Busca palpites salvos para a rodada a partir do banco de dados
  dbAccess.getPredictionsByRound(nextRound)
    .then(predsFromDB => {
      // Monta as linhas de cada jogo
      let rows = '';
      matches.forEach(match => {
        const home = data.teams.find(t => t.id === match.home_team_id);
        const away = data.teams.find(t => t.id === match.away_team_id);
        // Utiliza pontos coloridos para representar as equipes ao invés de logotipos
        const homeDot = getTeamDot(home, true);
        const awayDot = getTeamDot(away, true);
        let row = `<tr><td>${homeDot} ${home.name} x ${awayDot} ${away.name}</td>`;
        presenters.forEach(p => {
          // Busca o palpite deste apresentador para esta partida na lista obtida do banco
          const pred = predsFromDB.find(pr => pr.match_id === match.id && pr.user_id === p.id);
          const homeVal = pred ? pred.home_score : '';
          const awayVal = pred ? pred.away_score : '';
          const savedClass = pred ? 'saved-cell' : '';
          let resultText = '-';
          if (pred && pred.home_score !== null && pred.away_score !== null) {
            const h = parseInt(pred.home_score);
            const a = parseInt(pred.away_score);
            if (h > a) resultText = 'Casa';
            else if (h < a) resultText = 'Fora';
            else resultText = 'Empate';
          }
          row += `<td class="${savedClass}"><input type="number" name="home_${p.id}_${match.id}" id="home_${p.id}_${match.id}" value="${homeVal}" min="0" oninput="updateResult(${p.id}, ${match.id})"></td>`;
          row += `<td class="${savedClass}"><input type="number" name="away_${p.id}_${match.id}" id="away_${p.id}_${match.id}" value="${awayVal}" min="0" oninput="updateResult(${p.id}, ${match.id})"></td>`;
          row += `<td class="${savedClass}"><span id="result_${p.id}_${match.id}">${resultText}</span></td>`;
        });
        row += '</tr>';
        rows += row;
      });
      const nav = buildNavLinks(user);
      const html = renderTemplate('palpites.html', {
        table_head: tableHead,
        match_rows: rows,
        round_number: nextRound,
        message_html: messageHtml,
        admin_link: nav.adminLink,
        user_name: user.name
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    })
    .catch(err => {
      console.error('Erro ao obter palpites do banco:', err.message);
      // Em caso de erro, renderiza a página usando apenas as informações do JSON
      // Essa lógica é semelhante à versão original acima, mas sem destaque de palpites salvos
      let rows = '';
      matches.forEach(match => {
        const home = data.teams.find(t => t.id === match.home_team_id);
        const away = data.teams.find(t => t.id === match.away_team_id);
        // Representa as equipes por pontos coloridos em caso de fallback do banco
        const homeDot = getTeamDot(home, true);
        const awayDot = getTeamDot(away, true);
        let row = `<tr><td>${homeDot} ${home.name} x ${awayDot} ${away.name}</td>`;
        presenters.forEach(p => {
          const pred = data.predictions.find(pr => pr.match_id === match.id && pr.user_id === p.id);
          const homeVal = pred ? pred.home_score : '';
          const awayVal = pred ? pred.away_score : '';
          const savedClass = pred ? 'saved-cell' : '';
          let resultText = '-';
          if (pred && pred.home_score !== null && pred.away_score !== null) {
            const h = parseInt(pred.home_score);
            const a = parseInt(pred.away_score);
            if (h > a) resultText = 'Casa';
            else if (h < a) resultText = 'Fora';
            else resultText = 'Empate';
          }
          row += `<td class="${savedClass}"><input type="number" name="home_${p.id}_${match.id}" id="home_${p.id}_${match.id}" value="${homeVal}" min="0" oninput="updateResult(${p.id}, ${match.id})"></td>`;
          row += `<td class="${savedClass}"><input type="number" name="away_${p.id}_${match.id}" id="away_${p.id}_${match.id}" value="${awayVal}" min="0" oninput="updateResult(${p.id}, ${match.id})"></td>`;
          row += `<td class="${savedClass}"><span id="result_${p.id}_${match.id}">${resultText}</span></td>`;
        });
        row += '</tr>';
        rows += row;
      });
      const nav = buildNavLinks(user);
      const html = renderTemplate('palpites.html', {
        table_head: tableHead,
        match_rows: rows,
        round_number: nextRound,
        message_html: messageHtml,
        admin_link: nav.adminLink,
        user_name: user.name
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    });
}

function handlePalpitesPost(req, res, user) {
  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });
  req.on('end', () => {
    const dataStore = loadData();
    const form = querystring.parse(body);
    // Determine current round across all presenters
    const round = getNextRoundForAll(dataStore);
    if (!round) {
      sendRedirect(res, '/palpites');
      return;
    }
    // Apenas partidas que não estão excluídas de palpites
    const matches = dataStore.matches.filter(m => m.round === round && !excludedMatchIds.has(m.id));
    const presenters = dataStore.users.filter(u => !u.isAdmin);
    // Compute max id once for new predictions
    let maxId = 0;
    dataStore.predictions.forEach(p => { if (p.id > maxId) maxId = p.id; });
    // Iterate through matches and presenters
    // Armazena palpites em memória e agrupa por apresentador para posterior
    // persistência no banco SQLite
    const predsByUser = {};
    matches.forEach(match => {
      presenters.forEach(p => {
        const homeKey = `home_${p.id}_${match.id}`;
        const awayKey = `away_${p.id}_${match.id}`;
        const hVal = form[homeKey];
        const aVal = form[awayKey];
        if (hVal !== undefined && aVal !== undefined && hVal !== '' && aVal !== '') {
          const h = parseInt(hVal);
          const a = parseInt(aVal);
          // Atualiza ou insere no JSON local
          let pred = dataStore.predictions.find(pr => pr.match_id === match.id && pr.user_id === p.id);
          if (pred) {
            pred.home_score = h;
            pred.away_score = a;
          } else {
            maxId += 1;
            dataStore.predictions.push({ id: maxId, match_id: match.id, user_id: p.id, home_score: h, away_score: a });
          }
          // Agrupa para salvar no banco depois
          if (!predsByUser[p.id]) predsByUser[p.id] = [];
          predsByUser[p.id].push({ match_id: match.id, home_score: h, away_score: a });
        }
      });
    });
    // Atualiza arquivo JSON
    writeJSON('predictions.json', dataStore.predictions);
    // Persiste no banco de dados para cada apresentador
    const roundPromises = [];
    const roundNumber = round;
    Object.keys(predsByUser).forEach(uid => {
      const list = predsByUser[uid];
      roundPromises.push(dbAccess.savePredictionsForRound(roundNumber, parseInt(uid), list));
    });
    Promise.all(roundPromises)
      .then(() => {
        sendRedirect(res, '/palpites?saved=1');
      })
      .catch(err => {
        console.error('Erro ao salvar palpites no banco:', err.message);
        sendRedirect(res, '/palpites?saved=1');
      });
  });
}


function handleRanking(req, res, user) {
  const data = loadData();
  const parsedUrl = url.parse(req.url, true);
  const selectedRound = parsedUrl.query.round ? parseInt(parsedUrl.query.round, 10) : null;
  
  // Buscar palpites do banco
  dbAccess.getPredictions()
    .then(predsFromDB => {
      // Encontrar a última rodada com pontuação
      const lastRound = getLastRoundWithPoints(data.matches, predsFromDB);
      
      if (!lastRound) {
        res.statusCode = 404;
        res.end('Nenhuma rodada com resultados encontrada');
        return;
      }
      
      // Filtrar partidas da última rodada
      const lastRoundMatches = data.matches
        .filter(m => m.round === lastRound && !excludedMatchIds.has(m.id))
        .sort((a, b) => a.id - b.id);
      
      // Buscar palpites do apresentador para a última rodada
      const presenterPredictions = predsFromDB.filter(p => 
        p.user_id === presenterId && 
        lastRoundMatches.some(m => m.id === p.match_id)
      );
      
      // Gerar HTML dos jogos individuais
      let matchesHtml = '';
      let totalPoints = 0;
      
      lastRoundMatches.forEach((match, index) => {
        const homeTeam = data.teams.find(t => t.id === match.home_team_id);
        const awayTeam = data.teams.find(t => t.id === match.away_team_id);
        const prediction = presenterPredictions.find(p => p.match_id === match.id);
        
        if (prediction) {
          const pointsData = calculatePredictionPoints(prediction, match);
          totalPoints += pointsData.points;
          
          const statusClass = pointsData.status === 'exact' ? 'points-exact' : 
                             pointsData.status === 'result' ? 'points-result' : 'points-wrong';
          
          const statusText = pointsData.status === 'exact' ? 'EXATO' : 
                            pointsData.status === 'result' ? 'RESULTADO' : 'ERRO';
          
          matchesHtml += `
            <div class="match-card">
              <div class="match-header">
                <div class="match-teams">
                  <span class="match-number">${index + 1}</span>
                  ${homeTeam.name} x ${awayTeam.name}
                </div>
                <div class="match-result">${match.home_score} x ${match.away_score}</div>
              </div>
              <div class="match-details">
                <div class="detail-item prediction">
                  <div class="detail-label">Palpite</div>
                  <div class="detail-value">${prediction.home_score} x ${prediction.away_score}</div>
                </div>
                <div class="detail-item points">
                  <div class="detail-label">Pontos</div>
                  <div class="detail-value ${statusClass}">${pointsData.points}</div>
                </div>
                <div class="detail-item status">
                  <div class="detail-label">Status</div>
                  <div class="detail-value ${statusClass}">${statusText}</div>
                </div>
              </div>
            </div>
          `;
        }
      });
      
      // Gerar tabela resumo comparativa
      const allPresenters = data.users.filter(u => !u.isAdmin);
      let presentersHeaders = '';
      allPresenters.forEach(p => {
        const isCurrentPresenter = p.id === presenterId;
        const headerClass = isCurrentPresenter ? 'presenter-column' : '';
        presentersHeaders += `<th class="${headerClass}">${p.name}</th>`;
      });
      
      let summaryRows = '';
      let presenterTotals = {};
      allPresenters.forEach(p => { presenterTotals[p.id] = 0; });
      
      lastRoundMatches.forEach((match, index) => {
        const homeTeam = data.teams.find(t => t.id === match.home_team_id);
        const awayTeam = data.teams.find(t => t.id === match.away_team_id);
        
        let row = `
          <tr>
            <td><strong>Jogo ${index + 1}</strong><br><span class="team-names">${homeTeam.name} x ${awayTeam.name}</span></td>
            <td><strong>${match.home_score} x ${match.away_score}</strong></td>
        `;
        
        allPresenters.forEach(p => {
          const pred = predsFromDB.find(pr => pr.match_id === match.id && pr.user_id === p.id);
          const isCurrentPresenter = p.id === presenterId;
          const cellClass = isCurrentPresenter ? 'presenter-column' : '';
          
          if (pred) {
            const pointsData = calculatePredictionPoints(pred, match);
            presenterTotals[p.id] += pointsData.points;
            
            const statusClass = pointsData.status === 'exact' ? 'points-exact' : 
                               pointsData.status === 'result' ? 'points-result' : 'points-wrong';
            
            row += `<td class="${cellClass}"><strong>${pred.home_score}x${pred.away_score}</strong><br><span class="${statusClass}">${pointsData.points} pts</span></td>`;
          } else {
            row += `<td class="${cellClass}">-</td>`;
          }
        });
        
        row += '</tr>';
        summaryRows += row;
      });
      
      // Linha de totais
      let totalPointsRow = '';
      allPresenters.forEach(p => {
        const isCurrentPresenter = p.id === presenterId;
        const cellClass = isCurrentPresenter ? 'presenter-column' : '';
        totalPointsRow += `<td class="${cellClass}"><strong>${presenterTotals[p.id]} pontos</strong></td>`;
      });
      
      const nav = buildNavLinks(user);
      const html = renderTemplate('presenter_detail.html', {
        presenter_name: presenter.name,
        round_name: `Rodada ${lastRound}`,
        total_points: totalPoints,
        matches_html: matchesHtml,
        presenters_headers: presentersHeaders,
        summary_rows: summaryRows,
        total_points_row: totalPointsRow,
        admin_link: nav.adminLink,
        auth_link: nav.authLink
      });
      
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    })
    .catch(err => {
      console.error('Erro ao buscar palpites:', err);
      res.statusCode = 500;
      res.end('Erro interno do servidor');
    });
}

function handleRanking(req, res, user) {
  const data = loadData();
  // Analisa a rodada selecionada (por exemplo, /ranking?round=17)
  const parsedUrl = url.parse(req.url, true);
  const selectedRound = parsedUrl.query.round ? parseInt(parsedUrl.query.round, 10) : null;
  const presenters = data.users.filter(u => !u.isAdmin);
  // Busca todos os palpites do banco
  dbAccess.getPredictions()
    .then(predsFromDB => {
      const ranking = [];
      presenters.forEach(u => {
        let total = 0;
        let exactCount = 0;
        let resultCount = 0;
        let errorCount = 0;
        const details = [];
        // Filtra palpites deste usuário
        predsFromDB
          .filter(p => p.user_id === u.id)
          .forEach(pred => {
            const match = data.matches.find(m => m.id === pred.match_id);
            // Se a partida não existe ou está excluída, ignora
            if (!match || excludedMatchIds.has(match.id)) return;
            // Se uma rodada específica foi selecionada, ignore partidas de outras rodadas
            if (selectedRound && match.round !== selectedRound) return;
            if (match.home_score !== null && match.away_score !== null) {
              const predSign = resultSign(pred.home_score, pred.away_score);
              const realSign = resultSign(match.home_score, match.away_score);
              let points = 0;
              if (pred.home_score === match.home_score && pred.away_score === match.away_score) {
                points = 3;
                exactCount += 1;
              } else if (predSign === realSign) {
                points = 1;
                resultCount += 1;
              } else {
                errorCount += 1;
              }
              total += points;
              const homeTeam = data.teams.find(t => t.id === match.home_team_id);
              const awayTeam = data.teams.find(t => t.id === match.away_team_id);
              details.push({
                round: match.round,
                confrontation: `${homeTeam.name} x ${awayTeam.name}`,
                prediction: `${pred.home_score}-${pred.away_score}`,
                result: `${match.home_score}-${match.away_score}`,
                points
              });
            }
          });
        ranking.push({ user: u, total, exactCount, resultCount, errorCount, details });
      });
      // Ordena pelo total de pontos (descendente)
      ranking.sort((a, b) => b.total - a.total);
      // Monta a lista de opções de rodada (ranking geral ou por rodada)
      const allRounds = Array.from(new Set(data.matches.map(m => m.round))).filter(r => {
        return data.matches.some(m => m.round === r && !excludedMatchIds.has(m.id));
      }).sort((a, b) => a - b);
      let selectorHtml = '<form method="get" action="/ranking" class="ranking-select-form">';
      selectorHtml += '<label for="round-select">Rodada:</label> ';
      selectorHtml += '<select id="round-select" name="round" onchange="this.form.submit()">';
      selectorHtml += `<option value=""${selectedRound ? '' : ' selected'}>Geral</option>`;
      allRounds.forEach(r => {
        selectorHtml += `<option value="${r}"${selectedRound === r ? ' selected' : ''}>${r}</option>`;
      });
      selectorHtml += '</select></form>';
      // Constrói os cards do ranking
      let cardsHtml = '';
      ranking.forEach((entry, idx) => {
        const u = entry.user;
        const place = idx + 1;
        // Mostrar apenas a última rodada com pontuação
        const lastRound = entry.details.length > 0 ? Math.max(...entry.details.map(d => d.round)) : 0;
        const lastRoundDetails = entry.details.filter(d => d.round === lastRound);
        
        let detailsRows = '';
        lastRoundDetails.forEach(d => {
          detailsRows += `<tr><td>${d.confrontation}</td><td>${d.prediction}</td><td>${d.result}</td><td>${d.points}</td></tr>`;
        });
        const detailsTable = `<table><thead><tr><th>Confronto</th><th>Palpite</th><th>Resultado</th><th>Pts</th></tr></thead><tbody>${detailsRows}</tbody></table>`;
        
        // Calcular pontuação da última rodada para ranking geral
        let lastRoundPoints = '';
        if (!selectedRound) { // Apenas no ranking geral
          // Encontrar a última rodada com jogos finalizados
          const lastRound = Math.max(...entry.details.map(d => d.round));
          const lastRoundDetails = entry.details.filter(d => d.round === lastRound);
          const lastRoundTotal = lastRoundDetails.reduce((sum, d) => sum + d.points, 0);
          lastRoundPoints = ` <span class="last-round-points">(+${lastRoundTotal})</span>`;
        }
        
        cardsHtml += `<div class="ranking-card"><div class="card-header" onclick="toggleCard(${u.id})"><span>${place}º ${u.name}${lastRoundPoints} - ${entry.total} pts</span><span>Exatos: ${entry.exactCount} | Resultados: ${entry.resultCount} | Erros: ${entry.errorCount}</span></div><div id="card-body-${u.id}" class="card-body">${detailsTable}</div></div>`;
      });
      // ============================================
      // Construção dos dados para o gráfico de evolução
      // ============================================
      // Lista de todas as rodadas, ordenadas
      const allRoundsForChart = Array.from(new Set(data.matches.map(m => m.round))).sort((a, b) => a - b);
      // Estruturas para pontos cumulativos por usuário
      const cumulativeTotals = {};
      const series = {};
      presenters.forEach(p => {
        cumulativeTotals[p.id] = 0;
        series[p.name] = [];
      });
      // Calcula pontos acumulados por rodada
      allRoundsForChart.forEach(r => {
        // Partidas desta rodada (não excluídas)
        const matchesInRound = data.matches.filter(m => m.round === r && !excludedMatchIds.has(m.id));
        // Pontos obtidos nesta rodada por usuário
        const roundPoints = {};
        presenters.forEach(p => { roundPoints[p.id] = 0; });
        matchesInRound.forEach(match => {
          if (match.home_score !== null && match.away_score !== null) {
            presenters.forEach(p => {
              const pred = predsFromDB.find(pr => pr.match_id === match.id && pr.user_id === p.id);
              if (!pred) return;
              const predSign = resultSign(pred.home_score, pred.away_score);
              const realSign = resultSign(match.home_score, match.away_score);
              let points = 0;
              if (pred.home_score === match.home_score && pred.away_score === match.away_score) {
                points = 3;
              } else if (predSign === realSign) {
                points = 1;
              }
              roundPoints[p.id] += points;
            });
          }
        });
        // Atualiza cumulativos e armazena na série
        presenters.forEach(p => {
          cumulativeTotals[p.id] += roundPoints[p.id];
          series[p.name].push(cumulativeTotals[p.id]);
        });
      });
      const chartDataObj = { rounds: allRoundsForChart, series: series };
      const chartDataStr = JSON.stringify(chartDataObj);
      
      // Gerar tabela resumo da última rodada apenas no ranking geral
      let summaryTableHtml = '';
      if (!selectedRound) {
        // Encontrar a última rodada com resultados
        const lastRound = Math.max(...ranking.map(entry => 
          entry.details.length > 0 ? Math.max(...entry.details.map(d => d.round)) : 0
        ));
        
        // Obter partidas da última rodada
        const lastRoundMatches = data.matches
          .filter(m => m.round === lastRound && !excludedMatchIds.has(m.id))
          .sort((a, b) => a.id - b.id);
        
        if (lastRoundMatches.length > 0) {
          // Cabeçalho da tabela
          let tableHeader = '<tr><th>Jogo</th><th>Resultado</th>';
          presenters.forEach(p => {
            tableHeader += `<th>${p.name}</th>`;
          });
          tableHeader += '</tr>';
          
          // Linhas da tabela
          let tableRows = '';
          let presenterTotals = {};
          presenters.forEach(p => { presenterTotals[p.id] = 0; });
          
          lastRoundMatches.forEach((match, index) => {
            const homeTeam = data.teams.find(t => t.id === match.home_team_id);
            const awayTeam = data.teams.find(t => t.id === match.away_team_id);
            
            let row = `<tr><td><strong>Jogo ${index + 1}</strong><br><span class="team-names">${homeTeam.name} x ${awayTeam.name}</span></td>`;
            row += `<td><strong>${match.home_score} x ${match.away_score}</strong></td>`;
            
            presenters.forEach(p => {
              const pred = predsFromDB.find(pr => pr.match_id === match.id && pr.user_id === p.id);
              if (pred) {
                const predSign = resultSign(pred.home_score, pred.away_score);
                const realSign = resultSign(match.home_score, match.away_score);
                let points = 0;
                if (pred.home_score === match.home_score && pred.away_score === match.away_score) {
                  points = 3;
                } else if (predSign === realSign) {
                  points = 1;
                }
                presenterTotals[p.id] += points;
                
                const statusClass = points === 3 ? 'points-exact' : points === 1 ? 'points-result' : 'points-wrong';
                row += `<td><strong>${pred.home_score}x${pred.away_score}</strong><br><span class="${statusClass}">${points} pts</span></td>`;
              } else {
                row += '<td>-</td>';
              }
            });
            
            row += '</tr>';
            tableRows += row;
          });
          
          // Linha de totais
          let totalRow = '<tr class="total-row"><td colspan="2"><strong>TOTAL DE PONTOS</strong></td>';
          presenters.forEach(p => {
            totalRow += `<td><strong>${presenterTotals[p.id]} pontos</strong></td>`;
          });
          totalRow += '</tr>';
          
          summaryTableHtml = `
            <div class="summary-table-container">
              <h3>📊 Resumo da Rodada ${lastRound}</h3>
              <table class="summary-table">
                <thead>${tableHeader}</thead>
                <tbody>${tableRows}${totalRow}</tbody>
              </table>
            </div>
          `;
        }
      }
      
      const nav = buildNavLinks(user);
      const html = renderTemplate('ranking.html', {
        ranking_cards: cardsHtml,
        round_selector: selectorHtml,
        summary_table: summaryTableHtml,
        admin_link: nav.adminLink,
        auth_link: nav.authLink,
        chart_data: chartDataStr
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    })
    .catch(err => {
      console.error('Erro ao obter palpites do banco para ranking:', err.message);
      // Fallback para a implementação anterior usando JSON caso o banco falhe
      // (O código original foi mantido aqui como fallback)
      const ranking = [];
      presenters.forEach(u => {
        let total = 0;
        let exactCount = 0;
        let resultCount = 0;
        let errorCount = 0;
        const details = [];
        data.predictions
          .filter(p => p.user_id === u.id)
          .forEach(pred => {
            const match = data.matches.find(m => m.id === pred.match_id);
            if (!match || excludedMatchIds.has(match.id)) return;
            if (selectedRound && match.round !== selectedRound) return;
            if (match.home_score !== null && match.away_score !== null) {
              const predSign = resultSign(pred.home_score, pred.away_score);
              const realSign = resultSign(match.home_score, match.away_score);
              let points = 0;
              if (pred.home_score === match.home_score && pred.away_score === match.away_score) {
                points = 3;
                exactCount += 1;
              } else if (predSign === realSign) {
                points = 1;
                resultCount += 1;
              } else {
                errorCount += 1;
              }
              total += points;
              const homeTeam = data.teams.find(t => t.id === match.home_team_id);
              const awayTeam = data.teams.find(t => t.id === match.away_team_id);
              details.push({
                round: match.round,
                confrontation: `${homeTeam.name} x ${awayTeam.name}`,
                prediction: `${pred.home_score}-${pred.away_score}`,
                result: `${match.home_score}-${match.away_score}`,
                points
              });
            }
          });
        ranking.push({ user: u, total, exactCount, resultCount, errorCount, details });
      });
      ranking.sort((a, b) => b.total - a.total);
      const allRounds = Array.from(new Set(data.matches.map(m => m.round))).filter(r => {
        return data.matches.some(m => m.round === r && !excludedMatchIds.has(m.id));
      }).sort((a, b) => a - b);
      let selectorHtml = '<form method="get" action="/ranking" class="ranking-select-form">';
      selectorHtml += '<label for="round-select">Rodada:</label> ';
      selectorHtml += '<select id="round-select" name="round" onchange="this.form.submit()">';
      selectorHtml += `<option value=""${selectedRound ? '' : ' selected'}>Geral</option>`;
      allRounds.forEach(r => {
        selectorHtml += `<option value="${r}"${selectedRound === r ? ' selected' : ''}>${r}</option>`;
      });
      selectorHtml += '</select></form>';
      let cardsHtml = '';
      ranking.forEach((entry, idx) => {
        const u = entry.user;
        const place = idx + 1;
        // Mostrar apenas a última rodada com pontuação
        const lastRound = entry.details.length > 0 ? Math.max(...entry.details.map(d => d.round)) : 0;
        const lastRoundDetails = entry.details.filter(d => d.round === lastRound);
        
        let detailsRows = '';
        lastRoundDetails.forEach(d => {
          detailsRows += `<tr><td>${d.confrontation}</td><td>${d.prediction}</td><td>${d.result}</td><td>${d.points}</td></tr>`;
        });
        const detailsTable = `<table><thead><tr><th>Confronto</th><th>Palpite</th><th>Resultado</th><th>Pts</th></tr></thead><tbody>${detailsRows}</tbody></table>`;
        
        // Calcular pontuação da última rodada para ranking geral (fallback)
        let lastRoundPoints = '';
        if (!selectedRound) { // Apenas no ranking geral
          // Encontrar a última rodada com jogos finalizados
          const lastRound = Math.max(...entry.details.map(d => d.round));
          const lastRoundDetails = entry.details.filter(d => d.round === lastRound);
          const lastRoundTotal = lastRoundDetails.reduce((sum, d) => sum + d.points, 0);
          lastRoundPoints = ` <span class="last-round-points">(+${lastRoundTotal})</span>`;
        }
        
        cardsHtml += `<div class="ranking-card"><div class="card-header" onclick="toggleCard(${u.id})"><span>${idx + 1}º ${u.name}${lastRoundPoints} - ${entry.total} pts</span><span>Exatos: ${entry.exactCount} | Resultados: ${entry.resultCount} | Erros: ${entry.errorCount}</span></div><div id="card-body-${u.id}" class="card-body">${detailsTable}</div></div>`;
      });
      // ============================================
      // Construção dos dados para o gráfico na via de fallback
      // ============================================
      const allRoundsForChart = Array.from(new Set(data.matches.map(m => m.round))).sort((a, b) => a - b);
      const cumulativeTotals = {};
      const series = {};
      presenters.forEach(p => {
        cumulativeTotals[p.id] = 0;
        series[p.name] = [];
      });
      allRoundsForChart.forEach(r => {
        const matchesInRound = data.matches.filter(m => m.round === r && !excludedMatchIds.has(m.id));
        const roundPoints = {};
        presenters.forEach(p => { roundPoints[p.id] = 0; });
        matchesInRound.forEach(match => {
          if (match.home_score !== null && match.away_score !== null) {
            presenters.forEach(p => {
              const pred = data.predictions.find(pr => pr.match_id === match.id && pr.user_id === p.id);
              if (!pred) return;
              const predSign = resultSign(pred.home_score, pred.away_score);
              const realSign = resultSign(match.home_score, match.away_score);
              let points = 0;
              if (pred.home_score === match.home_score && pred.away_score === match.away_score) {
                points = 3;
              } else if (predSign === realSign) {
                points = 1;
              }
              roundPoints[p.id] += points;
            });
          }
        });
        presenters.forEach(p => {
          cumulativeTotals[p.id] += roundPoints[p.id];
          series[p.name].push(cumulativeTotals[p.id]);
        });
      });
      const chartDataObj = { rounds: allRoundsForChart, series: series };
      const chartDataStr = JSON.stringify(chartDataObj);
      
      // Gerar tabela resumo da última rodada apenas no ranking geral
      let summaryTableHtml = '';
      if (!selectedRound) {
        // Encontrar a última rodada com resultados
        const lastRound = Math.max(...ranking.map(entry => 
          entry.details.length > 0 ? Math.max(...entry.details.map(d => d.round)) : 0
        ));
        
        // Obter partidas da última rodada
        const lastRoundMatches = data.matches
          .filter(m => m.round === lastRound && !excludedMatchIds.has(m.id))
          .sort((a, b) => a.id - b.id);
        
        if (lastRoundMatches.length > 0) {
          // Cabeçalho da tabela
          let tableHeader = '<tr><th>Jogo</th><th>Resultado</th>';
          presenters.forEach(p => {
            tableHeader += `<th>${p.name}</th>`;
          });
          tableHeader += '</tr>';
          
          // Linhas da tabela
          let tableRows = '';
          let presenterTotals = {};
          presenters.forEach(p => { presenterTotals[p.id] = 0; });
          
          lastRoundMatches.forEach((match, index) => {
            const homeTeam = data.teams.find(t => t.id === match.home_team_id);
            const awayTeam = data.teams.find(t => t.id === match.away_team_id);
            
            let row = `<tr><td><strong>Jogo ${index + 1}</strong><br><span class="team-names">${homeTeam.name} x ${awayTeam.name}</span></td>`;
            row += `<td><strong>${match.home_score} x ${match.away_score}</strong></td>`;
            
            presenters.forEach(p => {
              const pred = predsFromDB.find(pr => pr.match_id === match.id && pr.user_id === p.id);
              if (pred) {
                const predSign = resultSign(pred.home_score, pred.away_score);
                const realSign = resultSign(match.home_score, match.away_score);
                let points = 0;
                if (pred.home_score === match.home_score && pred.away_score === match.away_score) {
                  points = 3;
                } else if (predSign === realSign) {
                  points = 1;
                }
                presenterTotals[p.id] += points;
                
                const statusClass = points === 3 ? 'points-exact' : points === 1 ? 'points-result' : 'points-wrong';
                row += `<td><strong>${pred.home_score}x${pred.away_score}</strong><br><span class="${statusClass}">${points} pts</span></td>`;
              } else {
                row += '<td>-</td>';
              }
            });
            
            row += '</tr>';
            tableRows += row;
          });
          
          // Linha de totais
          let totalRow = '<tr class="total-row"><td colspan="2"><strong>TOTAL DE PONTOS</strong></td>';
          presenters.forEach(p => {
            totalRow += `<td><strong>${presenterTotals[p.id]} pontos</strong></td>`;
          });
          totalRow += '</tr>';
          
          summaryTableHtml = `
            <div class="summary-table-container">
              <h3>📊 Resumo da Rodada ${lastRound}</h3>
              <table class="summary-table">
                <thead>${tableHeader}</thead>
                <tbody>${tableRows}${totalRow}</tbody>
              </table>
            </div>
          `;
        }
      }
      
      const nav = buildNavLinks(user);
      const html = renderTemplate('ranking.html', {
        ranking_cards: cardsHtml,
        round_selector: selectorHtml,
        summary_table: summaryTableHtml,
        admin_link: nav.adminLink,
        auth_link: nav.authLink,
        chart_data: chartDataStr
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    });
}

function handleResultados(req, res, user) {
  const data = loadData();
  // Agrupa partidas por rodada, incluindo jogos sem placar definido. Isso
  // garante que partidas pendentes de resultado também sejam exibidas.
  const rounds = {};
  data.matches.forEach(match => {
    if (!rounds[match.round]) rounds[match.round] = [];
    rounds[match.round].push(match);
  });
  const sortedRounds = Object.keys(rounds)
    .map(r => parseInt(r))
    .sort((a, b) => b - a);
  // Busca todos os palpites do banco
  dbAccess
    .getPredictions()
    .then(predsFromDB => {
      let sectionsHtml = '';
      sortedRounds.forEach(r => {
        const matchesInRound = rounds[r];
        const presenters = data.users.filter(u => !u.isAdmin);
        let tableHead =
          '<tr><th>Confronto</th><th>Placar</th>';
        presenters.forEach(p => {
          tableHead += `<th>${p.name}</th>`;
        });
        tableHead += '</tr>';
        let tableRows = '';
        matchesInRound.forEach(match => {
          const homeTeam = data.teams.find(
            t => t.id === match.home_team_id
          );
          const awayTeam = data.teams.find(
            t => t.id === match.away_team_id
          );
          // Representa as equipes com pontos coloridos nas linhas de resultados
          const homeDot = getTeamDot(homeTeam, true);
          const awayDot = getTeamDot(awayTeam, true);
          // Exibe o placar se houver resultado; caso contrário, mostra hífen
          const scoreDisplay =
            match.home_score !== null && match.away_score !== null
              ? `${match.home_score}-${match.away_score}`
              : '-';
          let row = `<tr><td>${homeDot} ${homeTeam.name} x ${awayDot} ${awayTeam.name}</td><td>${scoreDisplay}</td>`;
          presenters.forEach(p => {
            const pred = predsFromDB.find(
              pr => pr.match_id === match.id && pr.user_id === p.id
            );
            if (pred) {
              if (
                match.home_score !== null &&
                match.away_score !== null
              ) {
                // Partida finalizada: calcula pontos
                const predSign = resultSign(
                  pred.home_score,
                  pred.away_score
                );
                const realSign = resultSign(
                  match.home_score,
                  match.away_score
                );
                let pts = 0;
                if (
                  pred.home_score === match.home_score &&
                  pred.away_score === match.away_score
                )
                  pts = 3;
                else if (predSign === realSign) pts = 1;
                row += `<td>${pred.home_score}-${pred.away_score} (${pts})</td>`;
              } else {
                // Partida ainda sem placar: mostra apenas o palpite
                row += `<td>${pred.home_score}-${pred.away_score}</td>`;
              }
            } else {
              row += `<td>-</td>`;
            }
          });
          row += '</tr>';
          tableRows += row;
        });
        sectionsHtml += `<div class="round-section"><h3 onclick="toggleRound(${r})">Rodada ${r}</h3><div id="round-body-${r}" style="display:none"><table>${tableHead}${tableRows}</table></div></div>`;
      });
      const nav = buildNavLinks(user);
      const html = renderTemplate('resultados.html', {
        round_sections: sectionsHtml,
        admin_link: nav.adminLink,
        auth_link: nav.authLink
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    })
    .catch(err => {
      console.error(
        'Erro ao obter palpites do banco para resultados:',
        err.message
      );
      // Fallback para implementação antiga usando JSON
      let sectionsHtml = '';
      sortedRounds.forEach(r => {
        const matchesInRound = rounds[r];
        const presenters = data.users.filter(u => !u.isAdmin);
        let tableHead =
          '<tr><th>Confronto</th><th>Placar</th>';
        presenters.forEach(p => {
          tableHead += `<th>${p.name}</th>`;
        });
        tableHead += '</tr>';
        let tableRows = '';
        matchesInRound.forEach(match => {
          const homeTeam = data.teams.find(
            t => t.id === match.home_team_id
          );
          const awayTeam = data.teams.find(
            t => t.id === match.away_team_id
          );
          // Representa as equipes com pontos coloridos nas linhas de resultados (fallback)
          const homeDot = getTeamDot(homeTeam, true);
          const awayDot = getTeamDot(awayTeam, true);
          // Exibe placar ou hífen
          const scoreDisplay =
            match.home_score !== null && match.away_score !== null
              ? `${match.home_score}-${match.away_score}`
              : '-';
          let row = `<tr><td>${homeDot} ${homeTeam.name} x ${awayDot} ${awayTeam.name}</td><td>${scoreDisplay}</td>`;
          presenters.forEach(p => {
            const pred = data.predictions.find(
              pr => pr.match_id === match.id && pr.user_id === p.id
            );
            if (pred) {
              if (
                match.home_score !== null &&
                match.away_score !== null
              ) {
                // Calcula pontos quando há placar
                const predSign = resultSign(
                  pred.home_score,
                  pred.away_score
                );
                const realSign = resultSign(
                  match.home_score,
                  match.away_score
                );
                let pts = 0;
                if (
                  pred.home_score === match.home_score &&
                  pred.away_score === match.away_score
                )
                  pts = 3;
                else if (predSign === realSign) pts = 1;
                row += `<td>${pred.home_score}-${pred.away_score} (${pts})</td>`;
              } else {
                // Mostra palpite sem pontuação quando não há placar
                row += `<td>${pred.home_score}-${pred.away_score}</td>`;
              }
            } else {
              row += `<td>-</td>`;
            }
          });
          row += '</tr>';
          tableRows += row;
        });
        sectionsHtml += `<div class="round-section"><h3 onclick="toggleRound(${r})">Rodada ${r}</h3><div id="round-body-${r}" style="display:none"><table>${tableHead}${tableRows}</table></div></div>`;
      });
      const nav = buildNavLinks(user);
      const html = renderTemplate('resultados.html', {
        round_sections: sectionsHtml,
        admin_link: nav.adminLink,
        auth_link: nav.authLink
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    });
}

/**
 * Página de simulação das últimas 6 rodadas. Esta rota exibe um formulário
 * com todas as partidas restantes do campeonato (rodadas 33 a 38) e permite
 * que o usuário preencha placares hipotéticos. A partir desses placares,
 * é possível calcular uma classificação final projetada sem alterar os
 * dados oficiais armazenados. A classificação base utilizada é lida a
 * partir do arquivo `classification.json` e é combinada com os resultados
 * fornecidos pelo usuário em tempo de execução via JavaScript no cliente.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {Object|null} user
 */
function handleSimulacao(req, res, user) {
  const data = loadData();
  // Construir navegação condicional para admin/login
  const nav = buildNavLinks(user);
  // Classificação base (até a última rodada disputada) – recalculamos
  // a tabela a partir das partidas já registradas no banco. Isso
  // garante que eventuais atualizações feitas via admin (por exemplo,
  // placares adicionados) sejam refletidas na classificação inicial da
  // simulação. A função computeClassification ignora partidas sem
  // placar (placar nulo), portanto ela considera apenas confrontos
  // finalizados.
  const baseClassification = computeClassification(data.teams, data.matches);
  // Definição das partidas das rodadas 33 a 38. Cada entrada contém a
  // rodada, a equipe mandante (home) e a visitante (away) identificadas
  // pelo ID conforme o cadastro em teams.json. A ordem dos confrontos é
  // relevante apenas para indexar os inputs gerados no front-end.
  // Definição das partidas das rodadas 33 a 38. Utilizamos essa lista
  // como base, mas filtraremos partidas que já tiveram placar definido
  // no banco de dados. Quando um jogo já tem um resultado computado via
  // admin (home_score e away_score diferentes de null em matches.json),
  // ele não aparece na simulação, garantindo que o usuário só possa
  // simular rodadas pendentes.
  const fullSchedule = [
    // Rodada 33
    { round: 33, home: 20, away: 3 },  // Amazonas x Novorizontino
    { round: 33, home: 14, away: 6 },  // Atlético-GO x Vila Nova
    { round: 33, home: 15, away: 13 }, // América-MG x CRB
    { round: 33, home: 7,  away: 11 }, // Remo x Athletic Club
    { round: 33, home: 8,  away: 10 }, // Avaí x Criciúma
    { round: 33, home: 12, away: 18 }, // Operário x Volta Redonda
    { round: 33, home: 19, away: 5 },  // Botafogo-SP x Cuiabá
    { round: 33, home: 2,  away: 9 },  // Coritiba x Athletico-PR
    { round: 33, home: 1,  away: 4 },  // Goiás x Chapecoense
    { round: 33, home: 17, away: 16 }, // Ferroviária x Paysandu
    // Rodada 34
    { round: 34, home: 3,  away: 19 }, // Novorizontino x Botafogo-SP
    { round: 34, home: 5,  away: 7 },  // Cuiabá x Remo
    { round: 34, home: 11, away: 15 }, // Athletic Club x América-MG
    { round: 34, home: 18, away: 2 },  // Volta Redonda x Coritiba
    { round: 34, home: 16, away: 8 },  // Paysandu x Avaí
    { round: 34, home: 10, away: 1 },  // Criciúma x Goiás
    { round: 34, home: 13, away: 14 }, // CRB x Atlético-GO
    { round: 34, home: 6,  away: 17 }, // Vila Nova x Ferroviária
    { round: 34, home: 4,  away: 12 }, // Chapecoense x Operário
    { round: 34, home: 9,  away: 20 }, // Athletico-PR x Amazonas
    // Rodada 35
    { round: 35, home: 14, away: 16 }, // Atlético-GO x Paysandu
    { round: 35, home: 2,  away: 13 }, // Coritiba x CRB
    { round: 35, home: 17, away: 10 }, // Ferroviária x Criciúma
    { round: 35, home: 1,  away: 9 },  // Goiás x Athletico-PR
    { round: 35, home: 8,  away: 11 }, // Avaí x Athletic Club
    { round: 35, home: 20, away: 5 },  // Amazonas x Cuiabá
    { round: 35, home: 7,  away: 4 },  // Remo x Chapecoense
    { round: 35, home: 12, away: 6 },  // Operário x Vila Nova
    { round: 35, home: 15, away: 3 },  // América-MG x Novorizontino
    { round: 35, home: 18, away: 19 }, // Volta Redonda x Botafogo-SP
    // Rodada 36
    { round: 36, home: 11, away: 17 }, // Athletic Club x Ferroviária
    { round: 36, home: 5,  away: 1 },  // Cuiabá x Goiás
    { round: 36, home: 3,  away: 7 },  // Novorizontino x Remo
    { round: 36, home: 9,  away: 18 }, // Athletico-PR x Volta Redonda
    { round: 36, home: 6,  away: 8 },  // Vila Nova x Avaí
    { round: 36, home: 10, away: 14 }, // Criciúma x Atlético-GO
    { round: 36, home: 13, away: 12 }, // CRB x Operário
    { round: 36, home: 16, away: 2 },  // Paysandu x Coritiba
    { round: 36, home: 4,  away: 15 }, // Chapecoense x América-MG
    { round: 36, home: 19, away: 20 }, // Botafogo-SP x Amazonas
    // Rodada 37
    { round: 37, home: 15, away: 5 },  // América-MG x Cuiabá
    { round: 37, home: 14, away: 12 }, // Atlético-GO x Operário
    { round: 37, home: 8,  away: 7 },  // Avaí x Remo
    { round: 37, home: 2,  away: 11 }, // Coritiba x Athletic Club
    { round: 37, home: 13, away: 6 },  // CRB x Vila Nova
    { round: 37, home: 10, away: 19 }, // Criciúma x Botafogo-SP
    { round: 37, home: 17, away: 9 },  // Ferroviária x Athletico-PR
    { round: 37, home: 1,  away: 3 },  // Goiás x Novorizontino
    { round: 37, home: 16, away: 20 }, // Paysandu x Amazonas
    { round: 37, home: 18, away: 4 },  // Volta Redonda x Chapecoense
    // Rodada 38
    { round: 38, home: 20, away: 2 },  // Amazonas x Coritiba
    { round: 38, home: 11, away: 16 }, // Athletic Club x Paysandu
    { round: 38, home: 9,  away: 15 }, // Athletico-PR x América-MG
    { round: 38, home: 19, away: 8 },  // Botafogo-SP x Avaí
    { round: 38, home: 4,  away: 14 }, // Chapecoense x Atlético-GO
    { round: 38, home: 5,  away: 10 }, // Cuiabá x Criciúma
    { round: 38, home: 3,  away: 13 }, // Novorizontino x CRB
    { round: 38, home: 12, away: 17 }, // Operário x Ferroviária
    { round: 38, home: 7,  away: 1 },  // Remo x Goiás
    { round: 38, home: 6,  away: 18 }  // Vila Nova x Volta Redonda
  ];

  // Carrega partidas existentes para detectar quais jogos já foram disputados.
  // Consideramos um jogo disputado quando ambos os placares não são nulos.
  const existingMatches = data.matches;

  // Filtra a lista completa, removendo confrontos que já têm placares
  // registrados no banco (matches.json). A correspondência é feita por
  // rodada, time mandante e visitante. Se houver um match com esses
  // atributos e scores definidos, o confronto não deve aparecer na
  // simulação.
  const schedule = fullSchedule.filter(item => {
    const found = existingMatches.find(m => {
      return m.round === item.round && m.home_team_id === item.home && m.away_team_id === item.away;
    });
    if (!found) return true; // jogo ainda não cadastrado, então pode ser simulado
    return found.home_score === null || found.away_score === null;
  });
  // Serializa dados para injeção no front-end. Utilizamos JSON.stringify
  // para gerar strings válidas de JavaScript. Não removemos espaços ou
  // quebras de linha para melhor legibilidade.
  const scheduleJS = JSON.stringify(schedule);
  const classificationJS = JSON.stringify(baseClassification);
  const teamsJS = JSON.stringify(data.teams);
  const html = renderTemplate('simulacao.html', {
    schedule_js: scheduleJS,
    classification_js: classificationJS,
    teams_js: teamsJS,
    admin_link: nav.adminLink,
    auth_link: nav.authLink
  });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
}

function handleArtilharia(req, res, user) {
  const data = loadData();
  // Sort scorers by goals desc
  const sorted = [...data.scorers].sort((a, b) => {
    if (b.goals !== a.goals) return b.goals - a.goals;
    return a.player.localeCompare(b.player);
  });
  let rows = '';
  sorted.forEach((s, idx) => {
    const team = data.teams.find(t => t.id === s.team_id);
    // Determine icon
    let icon = '';
    const rank = idx + 1;
    if (rank === 1) icon = '<i class="fa-solid fa-trophy" style="color:#fbc02d;"></i>';
    else if (rank <= 3) icon = '<i class="fa-solid fa-medal" style="color:#b0bec5;"></i>';
    else if (rank <= 10) icon = '<i class="fa-solid fa-star" style="color:#ffa000;"></i>';
    // Representa o time com um ponto colorido seguido do nome
    const teamDot = getTeamDot(team, true);
    rows += `<tr><td>${rank}</td><td>${s.player}</td><td>${teamDot} ${team.name}</td><td>${s.goals}</td><td>${icon}</td></tr>`;
  });
  const nav = buildNavLinks(user);
  const html = renderTemplate('artilharia.html', {
    scorers_rows: rows,
    admin_link: nav.adminLink,
    auth_link: nav.authLink
  });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
}

function handleAdminGet(req, res, user) {
  const data = loadData();
  // Build match rows for editing (show all matches)
  let matchRows = '';
  data.matches.forEach(match => {
    const home = data.teams.find(t => t.id === match.home_team_id);
    const away = data.teams.find(t => t.id === match.away_team_id);
    const hVal = match.home_score !== null ? match.home_score : '';
    const aVal = match.away_score !== null ? match.away_score : '';
    matchRows += `<tr><td>${home.name} x ${away.name} (Rod. ${match.round})</td><td>${match.date}</td>`+
                 `<td><input type="number" name="home_${match.id}" value="${hVal}" min="0"></td>`+
                 `<td><input type="number" name="away_${match.id}" value="${aVal}" min="0"></td></tr>`;
  });
  // A tabela de classificação deixou de ser editável via Admin. Por isso não
  // construímos linhas de edição para ela. A classificação é calculada
  // automaticamente a partir dos resultados das partidas.
  const classRows = '';
  // Build scorer rows for editing. Each row allows editing the player's name,
  // selecting a team from a dropdown and changing the number of goals. The
  // index `idx` is preserved so the server can correlate form fields back
  // to the correct entry in the scorers array.
  let scorerRows = '';
  data.scorers.forEach((s, idx) => {
    const currentTeam = data.teams.find(t => t.id === s.team_id);
    // Build select options for each team
    let options = '';
    data.teams.forEach(team => {
      const selected = team.id === s.team_id ? ' selected' : '';
      options += `<option value="${team.id}"${selected}>${team.name}</option>`;
    });
    const select = `<select name="team_${idx}">${options}</select>`;
    scorerRows += `<tr>`+
                 `<td><input type="text" name="player_${idx}" value="${s.player}" required></td>`+
                 `<td>${select}</td>`+
                 `<td><input type="number" name="goals_${idx}" value="${s.goals}" min="0" required></td>`+
                 `</tr>`;
  });
  const html = renderTemplate('admin.html', {
    match_rows: matchRows,
    class_rows: classRows,
    scorer_rows: scorerRows,
    user_name: user.name
  });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
}

function handleAdminUpdateMatches(req, res, user) {
  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });
  req.on('end', () => {
    const dataStore = loadData();
    const form = querystring.parse(body);
    // Faz uma cópia profunda das partidas antes de aplicar as alterações para
    // determinar as diferenças de placar posteriormente
    const oldMatches = JSON.parse(JSON.stringify(dataStore.matches));
    dataStore.matches.forEach(match => {
      const homeKey = `home_${match.id}`;
      const awayKey = `away_${match.id}`;
      const hVal = form[homeKey];
      const aVal = form[awayKey];
      if (hVal !== undefined && aVal !== undefined) {
        match.home_score = hVal !== '' ? parseInt(hVal) : null;
        match.away_score = aVal !== '' ? parseInt(aVal) : null;
      }
    });
    // Persiste os placares atualizados
    writeJSON('matches.json', dataStore.matches);
    // Atualiza a classificação incrementalmente apenas para os jogos cujo placar mudou.
    const updatedClassification = updateClassificationFromMatchChanges(
      dataStore.classification,
      oldMatches,
      dataStore.matches
    );
    // Opcional: ordenar a classificação atualizada pelos critérios usuais
    updatedClassification.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.goal_diff !== a.goal_diff) return b.goal_diff - a.goal_diff;
      if (b.goals_for !== a.goals_for) return b.goals_for - a.goals_for;
      // Sem acesso ao array de equipes aqui, pode-se manter a ordem atual como último critério
      return 0;
    });
    writeJSON('classification.json', updatedClassification);
    sendRedirect(res, '/admin');
  });
}

function handleAdminUpdateClassification(req, res, user) {
  // Neste projeto a classificação é recalculada automaticamente a partir
  // dos resultados das partidas. Portanto, quaisquer valores enviados
  // pelo formulário de edição são ignorados. Ao receber esta requisição
  // (que ocorre quando o administrador clica em "Salvar Classificação"),
  // simplesmente recalcule a classificação com base nos placares atuais
  // e persista o arquivo correspondente. Isso garante que a tabela
  // apresentada no portal esteja sempre alinhada com os resultados.
  // Se no futuro for necessário ajustar critérios de desempate, basta
  // alterar a função computeClassification.
  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });
  req.on('end', () => {
    const dataStore = loadData();
    const updatedClassification = computeClassification(dataStore.teams, dataStore.matches);
    writeJSON('classification.json', updatedClassification);
    sendRedirect(res, '/admin');
  });
}

function handleAdminUpdateScorers(req, res, user) {
  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });
  req.on('end', () => {
    const dataStore = loadData();
    const form = querystring.parse(body);
    dataStore.scorers.forEach((s, idx) => {
      // Update player name if provided
      const playerKey = `player_${idx}`;
      if (form[playerKey] !== undefined && form[playerKey].trim() !== '') {
        s.player = form[playerKey].trim();
      }
      // Update team ID if provided
      const teamKey = `team_${idx}`;
      if (form[teamKey] !== undefined) {
        const newTeamId = parseInt(form[teamKey]);
        // Only assign if it corresponds to an existing team
        const exists = dataStore.teams.find(t => t.id === newTeamId);
        if (exists) {
          s.team_id = newTeamId;
        }
      }
      // Update goals if provided
      const goalsKey = `goals_${idx}`;
      if (form[goalsKey] !== undefined) {
        const parsedGoals = parseInt(form[goalsKey]);
        s.goals = isNaN(parsedGoals) ? 0 : parsedGoals;
      }
    });
    // After updating, sort by descending goals and reassign ranks
    dataStore.scorers.sort((a, b) => {
      if (b.goals !== a.goals) return b.goals - a.goals;
      // Tiebreaker: alphabetical by player name
      return a.player.localeCompare(b.player);
    });
    dataStore.scorers.forEach((s, i) => {
      s.rank = i + 1;
    });
    writeJSON('scorers.json', dataStore.scorers);
    sendRedirect(res, '/admin');
  });
}

// Create HTTP server
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;
  const user = getUserFromRequest(req);
  // Serve static assets
  if (pathname.startsWith('/static/')) {
    handleStatic(req, res, pathname);
    return;
  }
  if (pathname === '/' && method === 'GET') {
    handleHome(req, res, user);
    return;
  }
  if (pathname === '/login' && method === 'GET') {
    handleLoginGet(req, res);
    return;
  }
  if (pathname === '/login' && method === 'POST') {
    handleLoginPost(req, res);
    return;
  }
  if (pathname === '/logout') {
    handleLogout(req, res);
    return;
  }
  if (pathname === '/palpites') {
    if (!user) {
      sendRedirect(res, '/login');
      return;
    }
    if (method === 'GET') {
      handlePalpitesGet(req, res, user);
    } else if (method === 'POST') {
      handlePalpitesPost(req, res, user);
    }
    return;
  }
  if (pathname === '/ranking' && method === 'GET') {
    handleRanking(req, res, user);
    return;
  }

  if (pathname === '/resultados' && method === 'GET') {
    handleResultados(req, res, user);
    return;
  }
  if (pathname === '/artilharia' && method === 'GET') {
    handleArtilharia(req, res, user);
    return;
  }

  // Rota de simulação das últimas 6 rodadas
  if (pathname === '/simulacao' && method === 'GET') {
    // Qualquer usuário (logado ou não) pode acessar a simulação
    handleSimulacao(req, res, user);
    return;
  }
  if (pathname === '/admin') {
    if (!user || !user.isAdmin) {
      sendRedirect(res, '/');
      return;
    }
    if (method === 'GET') {
      handleAdminGet(req, res, user);
    }
    return;
  }
  if (pathname === '/admin/update_matches' && method === 'POST') {
    if (!user || !user.isAdmin) {
      sendRedirect(res, '/');
      return;
    }
    handleAdminUpdateMatches(req, res, user);
    return;
  }
  if (pathname === '/admin/update_classification' && method === 'POST') {
    if (!user || !user.isAdmin) {
      sendRedirect(res, '/');
      return;
    }
    handleAdminUpdateClassification(req, res, user);
    return;
  }
  if (pathname === '/admin/update_scorers' && method === 'POST') {
    if (!user || !user.isAdmin) {
      sendRedirect(res, '/');
      return;
    }
    handleAdminUpdateScorers(req, res, user);
    return;
  }
  // Fallback 404
  res.statusCode = 404;
  res.end('Página não encontrada');
});

// Start server if run directly teste
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor iniciado em http://localhost:${PORT}`);
  });
}


module.exports = server;
