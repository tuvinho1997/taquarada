const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const querystring = require('querystring');
const crypto = require('crypto');
// Importa camada de acesso ao banco de dados. Esta camada fornece funções
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
  // Não reordena a classificação: usa a ordem fornecida pelo arquivo de dados (scrap).
  // Isso preserva exatamente a colocação dos times conforme definido externamente,
  // em vez de aplicar critérios de desempate aqui.
  const sorted = data.classification;
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
        let detailsRows = '';
        entry.details.forEach(d => {
          detailsRows += `<tr><td>${d.round}</td><td>${d.confrontation}</td><td>${d.prediction}</td><td>${d.result}</td><td>${d.points}</td></tr>`;
        });
        const detailsTable = `<table><thead><tr><th>Rodada</th><th>Confronto</th><th>Palpite</th><th>Resultado</th><th>Pts</th></tr></thead><tbody>${detailsRows}</tbody></table>`;
        cardsHtml += `<div class="ranking-card"><div class="card-header" onclick="toggleCard(${u.id})"><span>${place}º ${u.name} - ${entry.total} pts</span><span>Exatos: ${entry.exactCount} | Resultados: ${entry.resultCount} | Erros: ${entry.errorCount}</span></div><div id="card-body-${u.id}" class="card-body">${detailsTable}</div></div>`;
      });
      const nav = buildNavLinks(user);
      const html = renderTemplate('ranking.html', {
        ranking_cards: cardsHtml,
        round_selector: selectorHtml,
        admin_link: nav.adminLink,
        auth_link: nav.authLink
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
        let detailsRows = '';
        entry.details.forEach(d => {
          detailsRows += `<tr><td>${d.round}</td><td>${d.confrontation}</td><td>${d.prediction}</td><td>${d.result}</td><td>${d.points}</td></tr>`;
        });
        const detailsTable = `<table><thead><tr><th>Rodada</th><th>Confronto</th><th>Palpite</th><th>Resultado</th><th>Pts</th></tr></thead><tbody>${detailsRows}</tbody></table>`;
        cardsHtml += `<div class="ranking-card"><div class="card-header" onclick="toggleCard(${u.id})"><span>${idx + 1}º ${u.name} - ${entry.total} pts</span><span>Exatos: ${entry.exactCount} | Resultados: ${entry.resultCount} | Erros: ${entry.errorCount}</span></div><div id="card-body-${u.id}" class="card-body">${detailsTable}</div></div>`;
      });
      const nav = buildNavLinks(user);
      const html = renderTemplate('ranking.html', {
        ranking_cards: cardsHtml,
        round_selector: selectorHtml,
        admin_link: nav.adminLink,
        auth_link: nav.authLink
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
  // Build classification rows for editing
  let classRows = '';
  data.classification.forEach(entry => {
    const team = data.teams.find(t => t.id === entry.team_id);
    classRows += `<tr><td>${team.name}</td>`+
                 `<td><input type="number" name="pts_${entry.team_id}" value="${entry.points}" min="0"></td>`+
                 `<td><input type="number" name="j_${entry.team_id}" value="${entry.games}" min="0"></td>`+
                 `<td><input type="number" name="v_${entry.team_id}" value="${entry.wins}" min="0"></td>`+
                 `<td><input type="number" name="e_${entry.team_id}" value="${entry.draws}" min="0"></td>`+
                 `<td><input type="number" name="d_${entry.team_id}" value="${entry.losses}" min="0"></td>`+
                 `<td><input type="number" name="gp_${entry.team_id}" value="${entry.goals_for}" min="0"></td>`+
                 `<td><input type="number" name="gc_${entry.team_id}" value="${entry.goals_against}" min="0"></td>`+
                 `<td><input type="number" name="sg_${entry.team_id}" value="${entry.goal_diff}" min="-100"></td></tr>`;
  });
  // Build scorer rows for editing
  let scorerRows = '';
  data.scorers.forEach((s, idx) => {
    const team = data.teams.find(t => t.id === s.team_id);
    scorerRows += `<tr><td>${s.player}</td><td>${team.name}</td>`+
                 `<td><input type="number" name="goals_${idx}" value="${s.goals}" min="0"></td>`+
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
    // Após atualizar os resultados, recalcule a classificação de forma automática.
    // Isso elimina a necessidade de editar manualmente a tabela de classificação.
    const updatedClassification = computeClassification(dataStore.teams, dataStore.matches);
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
      const key = `goals_${idx}`;
      if (form[key] !== undefined) {
        s.goals = parseInt(form[key]);
      }
    });
    // After updating goals, reassign ranks based on descending goals
    dataStore.scorers.sort((a, b) => b.goals - a.goals);
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
