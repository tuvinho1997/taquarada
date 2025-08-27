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

// === Dynamic classification computed from matches ===
function computeClassificationFromMatches(data) {
  const table = new Map(); // team_id -> stats
  function ensure(teamId) {
    if (!table.has(teamId)) {
      table.set(teamId, { team_id: teamId, points: 0, games: 0, wins: 0, draws: 0, losses: 0, goals_for: 0, goals_against: 0, goal_diff: 0 });
    }
    return table.get(teamId);
  }
  const played = data.matches.filter(m =>
    m.home_score !== null && m.away_score !== null && !excludedMatchIds.has(m.id)
  );
  for (const m of played) {
    const home = ensure(m.home_team_id);
    const away = ensure(m.away_team_id);
    home.games++; away.games++;
    home.goals_for += m.home_score; home.goals_against += m.away_score;
    away.goals_for += m.away_score; away.goals_against += m.home_score;
    if (m.home_score > m.away_score) { home.wins++; home.points += 3; away.losses++; }
    else if (m.home_score < m.away_score) { away.wins++; away.points += 3; home.losses++; }
    else { home.draws++; away.draws++; home.points++; away.points++; }
  }
  // compute goal diff
  for (const st of table.values()) st.goal_diff = st.goals_for - st.goals_against;

  // to array and sort by: points, goal_diff, wins, goals_for
  const arr = Array.from(table.values()).sort((a,b)=>{
    if (b.points !== a.points) return b.points - a.points;
    if (b.goal_diff !== a.goal_diff) return b.goal_diff - a.goal_diff;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return b.goals_for - a.goals_for;
  });
  return arr;
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
  const data = loadData(); // includes teams, matches, classification (snapshot)
  const snapshot = data.classification || []; // array of {team_id, points, games, wins, draws, losses, goals_for, goals_against, goal_diff}

  // Monta linhas da tabela com o MESMO layout da home
  let rows = '';
  const byTeamId = new Map();
  data.teams.forEach(t => byTeamId.set(t.id, t));

  // Ordena por pontos (desc) e depois saldo, vitórias, gols pró (igual a computeClassification fazia)
  const ordered = snapshot.slice().sort((a,b)=>{
    if (b.points !== a.points) return b.points - a.points;
    if (b.goal_diff !== a.goal_diff) return b.goal_diff - a.goal_diff;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return b.goals_for - a.goals_for;
  });

  // Para a coluna "Forma", podemos recomputar com base nos 5 últimos jogos disputados por cada time
  function last5Form(teamId) {
    const recent = data.matches
      .filter(m => (m.home_team_id===teamId || m.away_team_id===teamId) && m.home_score!==null && m.away_score!==null && !excludedMatchIds.has(m.id))
      .sort((a,b)=> new Date(b.date) - new Date(a.date))
      .slice(0,5);
    return recent.map(m => {
      const isHome = m.home_team_id===teamId;
      const hs=m.home_score, as=m.away_score;
      if ((isHome && hs>as) || (!isHome && as>hs)) return 'V';
      if ((isHome && hs<as) || (!isHome && as<hs)) return 'D';
      return 'E';
    });
  }

  ordered.forEach((st, idx) => {
    const team = byTeamId.get(st.team_id);
    const dot = getTeamDot(team);
    const teamLabel = `<div class="team-label">${dot}<span>${team.name}</span></div>`;
    const pos = idx + 1;

    let zoneClass = '';
    if (pos <= 4) zoneClass = 'zone-promotion';
    else if (pos >= (data.teams.length - 4) + 1) zoneClass = 'zone-relegation';

    const highlight = team.highlight ? 'highlight' : '';
    const formHtml = last5Form(team.id).map(r => {
      let cls='result-draw'; if (r==='V') cls='result-win'; else if (r==='D') cls='result-loss';
      return `<span class="${cls}"></span>`;
    }).join('');

    rows += `<tr class="${zoneClass} ${highlight}">
      <td>${pos}</td>
      <td>${teamLabel}</td>
      <td>${st.points}</td>
      <td>${st.games}</td>
      <td>${st.wins}</td>
      <td>${st.draws}</td>
      <td>${st.losses}</td>
      <td>${st.goals_for}:${st.goals_against}</td>
      <td>${st.goal_diff}</td>
      <td>${formHtml}</td>
    </tr>`;
  });

  const cricTeam = data.teams.find(t=>t.name==='Criciúma');
  const cricIndex = ordered.findIndex(e=> e.team_id === (cricTeam && cricTeam.id));
  const cricPos = cricIndex>=0 ? (cricIndex+1).toString() : '-';
  const lastUpdate = new Date().toISOString().slice(0,10);

  const { adminLink, authLink } = buildNavLinks(user);
  const html = renderTemplate('home.html', {
    table_rows: rows,
    admin_link: adminLink,
    auth_link: authLink,
    criciuma_position: cricPos,
    last_update: lastUpdate
  });
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

  // Considera somente partidas com placar definido
  const matchesById = new Map();
  data.matches.forEach(m => {
    if (m.home_score !== null && m.away_score !== null && !excludedMatchIds.has(m.id)) {
      if (!selectedRound || m.round <= selectedRound) {
        matchesById.set(m.id, m);
      }
    }
  });

  // Apresentadores (não-admin)
  const presenters = data.users.filter(u => !u.isAdmin);

  // Agrupar palpites válidos por usuário e por rodada
  const predsByUser = {};
  presenters.forEach(u => predsByUser[u.id] = []);
  data.predictions.forEach(p => {
    const match = matchesById.get(p.match_id);
    if (!match) return; // ignora jogos sem resultado ou fora do filtro de rodada
    predsByUser[p.user_id]?.push({ pred: p, match });
  });

  // Função para pontuar um palpite
  function score(pred, match) {
    const hs = pred.home_score, as = pred.away_score;
    if (hs === null || as === null) return 0;
    const exact = (hs === match.home_score && as === match.away_score);
    if (exact) return 3;
    const sign = (x, y) => (x>y?1:(x<y?-1:0));
    const same = sign(hs, as) === sign(match.home_score, match.away_score);
    return same ? 1 : 0;
  }

  // Acumular pontuação total e por rodada
  const ranking = [];
  const rounds = Array.from(new Set(Array.from(matchesById.values()).map(m => m.round))).sort((a,b)=>a-b);
  const series = {}; // para o gráfico: userName -> [pts acumulados por rodada]
  presenters.forEach(u => {
    let total = 0;
    let exactCount = 0, resultCount = 0, errorCount = 0;

    const byRound = new Map();
    rounds.forEach(r => byRound.set(r, 0));

    (predsByUser[u.id] || []).forEach(({pred, match}) => {
      const pts = score(pred, match);
      total += pts;
      if (pts === 3) exactCount++;
      else if (pts === 1) resultCount++;
      else errorCount++;
      byRound.set(match.round, (byRound.get(match.round) || 0) + pts);
    });

    // série acumulada por rodada
    let acc = 0;
    series[u.name] = rounds.map(r => { acc += (byRound.get(r) || 0); return acc; });

    ranking.push({ user: u, total, exactCount, resultCount, errorCount });
  });

  // Ordena ranking por total desc
  ranking.sort((a,b)=> b.total - a.total || a.user.name.localeCompare(b.user.name));

  // Round selector
  const roundOptions = ['<option value="">Geral</option>'].concat(rounds.map(r => {
    const sel = (selectedRound === r) ? ' selected' : '';
    return `<option value="${r}"${sel}>Rodada ${r}</option>`;
  }));
  const roundSelector = `<label>Rodada: <select onchange="location.href='/ranking?round='+this.value">${roundOptions.join('')}</select></label>`;

  // Monta cartões (cards) do ranking
  let cards = '';
  ranking.forEach((r, idx) => {
    const pos = idx+1;
    const medal = pos===1 ? '🥇' : pos===2 ? '🥈' : pos===3 ? '🥉' : '';
    const header = `<div class="card-header" onclick="toggleCard(${idx})">
        <span class="pos">${pos}</span>
        <span class="user-name">${r.user.name}</span>
        <span class="score"><strong>${r.total}</strong> pts ${medal}</span>
      </div>`;
    const body = `<div class="card-body" id="card-body-${idx}" style="display:none">
        <p>Exatos: ${r.exactCount} • Resultados: ${r.resultCount} • Erros: ${r.errorCount}</p>
      </div>`;
    cards += `<div class="ranking-card">${header}${body}</div>`;
  });

  // Dados do gráfico
  const chartData = JSON.stringify({ rounds, series });

  const { adminLink, authLink } = buildNavLinks(user);
  const html = renderTemplate('ranking.html', {
    admin_link: adminLink,
    auth_link: authLink,
    round_selector: roundSelector,
    ranking_cards: cards,
    chart_data: chartData
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
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
