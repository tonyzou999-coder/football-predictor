const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 8768;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

// ── 工具：发起HTTPS GET请求 ──────────────────────────────
function httpsGet(reqUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(reqUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/json,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...extraHeaders
      },
      timeout: 10000
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ── 爬取 ESPN 足球赛程（支持指定日期 yyyymmdd）──────────────
async function fetchESPN(dateStr) {
  // dateStr: yyyy-mm-dd → yyyymmdd
  const d = dateStr.replace(/-/g, '');
  const reqUrl = `https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?dates=${d}&limit=100`;
  const res = await httpsGet(reqUrl, { 'Accept': 'application/json' });
  if (res.status !== 200) throw new Error(`ESPN HTTP ${res.status}`);
  const json = JSON.parse(res.body);
  const events = json.events || [];
  return events.map(ev => {
    const comps = ev.competitions?.[0];
    const teams = comps?.competitors || [];
    const home = teams.find(t => t.homeAway === 'home') || teams[0] || {};
    const away = teams.find(t => t.homeAway === 'away') || teams[1] || {};
    return {
      id: ev.id,
      utcDate: ev.date,
      status: comps?.status?.type?.name || 'SCHEDULED',
      league: ev.season?.type?.name || ev.name || '',
      leagueCode: ev.leagues?.[0]?.abbreviation || 'INT',
      leagueName: ev.leagues?.[0]?.name || ev.name || 'International',
      homeTeam: {
        id: home.id,
        name: home.team?.displayName || home.team?.name || '未知',
        shortName: home.team?.shortDisplayName || home.team?.abbreviation || '?',
        crest: home.team?.logos?.[0]?.href || ''
      },
      awayTeam: {
        id: away.id,
        name: away.team?.displayName || away.team?.name || '未知',
        shortName: away.team?.shortDisplayName || away.team?.abbreviation || '?',
        crest: away.team?.logos?.[0]?.href || ''
      }
    };
  });
}

// ── 爬取 SofaScore（备用） ──────────────────────────────────
async function fetchSofaScore(dateStr) {
  const reqUrl = `https://api.sofascore.com/api/v1/sport/football/scheduled-events/${dateStr}`;
  const res = await httpsGet(reqUrl, {
    'Referer': 'https://www.sofascore.com/',
    'Origin': 'https://www.sofascore.com'
  });
  if (res.status !== 200) throw new Error(`SofaScore HTTP ${res.status}`);
  const json = JSON.parse(res.body);
  const events = json.events || [];
  return events.map(ev => ({
    id: String(ev.id),
    utcDate: new Date(ev.startTimestamp * 1000).toISOString(),
    status: ev.status?.type || 'scheduled',
    leagueCode: ev.tournament?.uniqueTournament?.id ? String(ev.tournament.uniqueTournament.id) : 'INT',
    leagueName: ev.tournament?.name || 'International',
    homeTeam: {
      id: String(ev.homeTeam?.id || ''),
      name: ev.homeTeam?.name || '未知',
      shortName: ev.homeTeam?.nameCode || ev.homeTeam?.shortName || '?',
      crest: ev.homeTeam?.id ? `https://api.sofascore.com/api/v1/team/${ev.homeTeam.id}/image` : ''
    },
    awayTeam: {
      id: String(ev.awayTeam?.id || ''),
      name: ev.awayTeam?.name || '未知',
      shortName: ev.awayTeam?.nameCode || ev.awayTeam?.shortName || '?',
      crest: ev.awayTeam?.id ? `https://api.sofascore.com/api/v1/team/${ev.awayTeam.id}/image` : ''
    }
  }));
}

// ── 内存缓存（同一日期缓存10分钟）───────────────────────────
const cache = {};
async function getMatches(dateStr) {
  const now = Date.now();
  if (cache[dateStr] && now - cache[dateStr].ts < 10 * 60 * 1000) {
    return cache[dateStr].data;
  }

  let matches = [];
  let source = '';

  // 优先 ESPN
  try {
    matches = await fetchESPN(dateStr);
    source = 'espn';
    console.log(`[ESPN] ${dateStr}: ${matches.length} matches`);
  } catch (e) {
    console.warn('[ESPN] failed:', e.message, '→ trying SofaScore');
    try {
      matches = await fetchSofaScore(dateStr);
      source = 'sofascore';
      console.log(`[SofaScore] ${dateStr}: ${matches.length} matches`);
    } catch (e2) {
      console.error('[SofaScore] failed:', e2.message);
      matches = [];
    }
  }

  cache[dateStr] = { ts: now, data: matches, source };
  return matches;
}

// ── HTTP 服务器 ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // /api/matches?date=yyyy-mm-dd
  if (pathname === '/api/matches') {
    const dateStr = parsed.query.date || new Date().toISOString().slice(0, 10);
    try {
      const matches = await getMatches(dateStr);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ date: dateStr, count: matches.length, matches }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Static files
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath) || '.html';
  if (!path.extname(filePath)) filePath += '.html';

  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    res.end(data, 'utf8');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Server running at http://127.0.0.1:' + PORT);
});
