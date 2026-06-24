const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');
const fs = require('fs');
const { Pool } = require('pg');
const { createClient } = require('redis');

// --- Mattermost config ---
const MM_URL        = process.env.MM_URL        || 'http://localhost:8065';
const MM_BOT_TOKEN  = process.env.MM_BOT_TOKEN;   // bot — for notifications/replies
const MM_ADMIN_TOKEN = process.env.MM_ADMIN_TOKEN; // admin user — directives go through bridge

// --- GitHub config ---
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOS = {
  'company-os':   'SkyDaddy001/company-os',
  'souloscope':   'SkyDaddy001/souloscope2.0',
  'mindprint':    'SkyDaddy001/mindprint_ai',
};

async function createGithubIssue(repo, title, body, labels = []) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
      },
      body: JSON.stringify({ title, body, labels }),
    });
    const data = await res.json();
    return { url: data.html_url, number: data.number, error: data.message };
  } catch (e) {
    return { error: e.message };
  }
}

// Project channels — routing by targetId suffix (_soul / _mind) then by dept
const CH_QUCOGROUP  = 'fpkydxtjyjrx8qyjugyzk1aaxc'; // #qucogroup-com
const CH_SOULOSCOPE = 'n5f9h1h5ktg738cc1tojhxu5ih'; // #souloscope
const CH_MINDPRINT  = '1fw6ukyixpnuzmt8nrtsc3iw1w'; // #mindprint
const CH_BOSS       = 'bxumznxnciy9pqg1e9api4oagy'; // #boss

// Route targetId → channel: suffix wins, then dept prefix fallback
function channelForDept(targetId) {
  if (targetId.endsWith('_soul'))  return CH_SOULOSCOPE;
  if (targetId.endsWith('_mind'))  return CH_MINDPRINT;
  return CH_QUCOGROUP; // company-os agents
}

// Notification post (bot) — for replies, completions, alerts
async function postToMattermost(channelId, message) {
  try {
    await fetch(`${MM_URL}/api/v4/posts`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${MM_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: channelId, message }),
    });
  } catch (e) {
    console.warn('Mattermost post failed:', e.message);
  }
}

// Directive post (admin user) — routes through mm-bridge → PicoClaw agent
async function postDirective(channelId, message) {
  const token = MM_ADMIN_TOKEN || MM_BOT_TOKEN;
  try {
    await fetch(`${MM_URL}/api/v4/posts`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: channelId, message }),
    });
  } catch (e) {
    console.warn('Directive post failed:', e.message);
  }
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(require('path').join(__dirname, 'dist')));

// --- DB + Redis clients ---
const db = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://ceo:os_password@localhost:5432/company_memory',
});

const publisher = createClient({ socket: { host: '127.0.0.1', port: 6379 } });
const subscriber = createClient({ socket: { host: '127.0.0.1', port: 6379 } });

async function initInfra() {
  await publisher.connect();
  await subscriber.connect();
  await db.query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ DEFAULT NOW(),
      type TEXT NOT NULL,
      target_id TEXT,
      payload TEXT,
      reply TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      target_id TEXT NOT NULL,
      cmd TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      reply TEXT
    );
  `);
  console.log('Postgres schema ready. Redis connected.');
}

initInfra().catch(err => console.error('Infra init error:', err));

// --- Helpers ---
function readMemory(targetId) {
  let ctx = '';
  let projectName = '';
  if (targetId.includes('soul')) projectName = 'souloscope';
  else if (targetId.includes('mind')) projectName = 'mindprint';

  try {
    const brand = fs.readFileSync('/home/ubuntu/company_memory/brand.yaml', 'utf8');
    const company = fs.readFileSync('/home/ubuntu/company_memory/company.yaml', 'utf8');
    ctx += `[COMPANY CONTEXT]\n${company}\n[BRAND VOICE]\n${brand}\n`;
    if (projectName) {
      const proj = fs.readFileSync(`/home/ubuntu/company_memory/projects/${projectName}/project.yaml`, 'utf8');
      ctx += `[PROJECT CONTEXT]\n${proj}\n`;
    }
  } catch (e) {
    console.error('Memory read error:', e.message);
  }
  return ctx;
}

async function publishEvent(type, targetId, payload, reply = '') {
  const event = { type, targetId, payload, reply, ts: new Date().toISOString() };
  try {
    await publisher.publish('os:events', JSON.stringify(event));
    await db.query(
      'INSERT INTO events (type, target_id, payload, reply) VALUES ($1,$2,$3,$4)',
      [type, targetId, payload, reply]
    );
  } catch (e) {
    console.error('publishEvent error:', e.message);
  }
}

// --- SSE: live event stream ---
const sseClients = new Set();

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send last 20 events on connect
  db.query('SELECT * FROM events ORDER BY ts DESC LIMIT 20')
    .then(({ rows }) => {
      rows.reverse().forEach(row => {
        res.write(`data: ${JSON.stringify({ type: row.type, targetId: row.target_id, payload: row.payload, reply: row.reply, ts: row.ts })}\n\n`);
      });
    })
    .catch(() => {});

  const send = (msg) => res.write(`data: ${msg}\n\n`);
  sseClients.add(send);
  req.on('close', () => sseClients.delete(send));
});

// Subscribe Redis and fan out to all SSE clients
subscriber.subscribe('os:events', (msg) => {
  sseClients.forEach(send => send(msg));
}).catch(err => console.error('Redis subscribe error:', err));

// Select the best Ollama model for a given target (prefer fast models)
function modelForTarget(targetId) {
  const available = global._ollamaModels || [];
  const prefer = ['llama3.2:1b', 'gemma3:4b', 'souloscope-qwen3:latest', 'qwen3:8b'];
  for (const m of prefer) {
    if (available.includes(m)) return m;
  }
  return available[0] || 'llama3.2:1b';
}

// Cache available models at startup
async function refreshOllamaModels() {
  try {
    const r = await fetch('http://localhost:11434/api/tags');
    const d = await r.json();
    global._ollamaModels = (d.models || []).map(m => m.name);
    console.log('Ollama models:', global._ollamaModels.join(', '));
  } catch (e) {
    console.warn('Could not reach Ollama:', e.message);
  }
}

refreshOllamaModels();

// --- POST /api/dispatch (streaming via SSE) ---
app.post('/api/dispatch', async (req, res) => {
  const { targetId, cmd } = req.body;
  if (!targetId || !cmd) return res.status(400).json({ reply: 'Missing targetId or cmd.' });

  let taskId;
  try {
    const { rows } = await db.query(
      'INSERT INTO tasks (target_id, cmd, status) VALUES ($1,$2,$3) RETURNING id',
      [targetId, cmd, 'in_progress']
    );
    taskId = rows[0].id;
  } catch (e) {
    console.error('DB task insert error:', e.message);
  }

  await publishEvent('task.dispatched', targetId, cmd);

  const channelId = channelForDept(targetId);
  // Post as admin so mm-bridge picks it up and routes to PicoClaw agent
  postDirective(channelId, cmd);

  const memCtx = readMemory(targetId);
  const model = modelForTarget(targetId);
  const systemPrompt = `You are the ${targetId} department agent inside QucoGroup's AI company OS. Brand voice: futuristic, precise, visionary. IMPORTANT: respond with EXACTLY one short sentence (under 20 words). No code, no lists, no markdown. Plain sentence only.`;

  // Stream response as SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  let fullReply = '';
  try {
    const ollamaResp = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: cmd }
        ],
        stream: true,
        options: { num_predict: 60, temperature: 0.5, stop: ['\n', '.'] }
      }),
      signal: AbortSignal.timeout(120000)
    });

    if (!ollamaResp.ok) throw new Error(`Ollama ${ollamaResp.status}`);

    const reader = ollamaResp.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value).split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const chunk = JSON.parse(line);
          const token = chunk.message?.content || '';
          if (token) {
            fullReply += token;
            res.write(`data: ${JSON.stringify({ token })}\n\n`);
          }
          if (chunk.done) break;
        } catch {}
      }
    }

    fullReply = fullReply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    res.write(`data: ${JSON.stringify({ done: true, reply: fullReply })}\n\n`);
    res.end();

    if (taskId) await db.query('UPDATE tasks SET status=$1, reply=$2 WHERE id=$3', ['completed', fullReply, taskId]);
    await publishEvent('task.completed', targetId, cmd, fullReply);
    postToMattermost(channelId, `**[${targetId}]** ✅ ${fullReply}`);
  } catch (e) {
    console.error('Ollama stream error:', e.message);
    const reply = `[${targetId}] Agent offline — inference unavailable.`;
    res.write(`data: ${JSON.stringify({ done: true, reply, error: true })}\n\n`);
    res.end();
    if (taskId) await db.query('UPDATE tasks SET status=$1, reply=$2 WHERE id=$3', ['failed', reply, taskId]);
    await publishEvent('task.failed', targetId, cmd, reply);
    postToMattermost(channelId, `**[${targetId}]** ⚠️ Agent offline — inference unavailable.`);
  }
});

// --- GET /api/health ---
app.get('/api/health', (req, res) => {
  const results = {};

  // RAM — /proc/meminfo
  try {
    const mem = require('fs').readFileSync('/proc/meminfo', 'utf8');
    const total = parseInt(mem.match(/MemTotal:\s+(\d+)/)?.[1] || 0);
    const avail = parseInt(mem.match(/MemAvailable:\s+(\d+)/)?.[1] || 0);
    const used = total - avail;
    results.ram = {
      total_mb: Math.round(total / 1024),
      used_mb: Math.round(used / 1024),
      pct: Math.round((used / total) * 100),
    };
  } catch {}

  // Disk — df on /
  exec('df -k / --output=size,used,avail', (_, stdout) => {
    try {
      const [, line] = stdout.trim().split('\n');
      const [size, used, avail] = line.trim().split(/\s+/).map(Number);
      results.disk = {
        total_gb: (size / 1024 / 1024).toFixed(1),
        used_gb: (used / 1024 / 1024).toFixed(1),
        free_gb: (avail / 1024 / 1024).toFixed(1),
        pct: Math.round((used / size) * 100),
      };
    } catch {}

    // Network I/O — /proc/net/dev (eth0 or first non-lo iface)
    try {
      const netdev = require('fs').readFileSync('/proc/net/dev', 'utf8');
      const lines = netdev.trim().split('\n').slice(2);
      for (const line of lines) {
        const [iface, ...parts] = line.trim().split(/\s+/);
        const name = iface.replace(':', '');
        if (name === 'lo') continue;
        results.net = {
          iface: name,
          rx_mb: (parseInt(parts[0]) / 1024 / 1024).toFixed(1),
          tx_mb: (parseInt(parts[8]) / 1024 / 1024).toFixed(1),
        };
        break;
      }
    } catch {}

    // CPU — /proc/loadavg
    try {
      const load = require('fs').readFileSync('/proc/loadavg', 'utf8').split(' ');
      results.cpu = { load1: load[0], load5: load[1], load15: load[2] };
    } catch {}

    res.json(results);
  });
});

// --- GET /api/services — per-project health for planet status ---
app.get('/api/services', async (req, res) => {
  const check = (url, timeoutMs = 3000) =>
    fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
      .then(r => r.ok)
      .catch(() => false);

  const checkDocker = (name) => new Promise(resolve => {
    exec(`docker inspect --format='{{.State.Running}}' ${name} 2>/dev/null`, (_, out) =>
      resolve(out.trim() === 'true'));
  });

  const [
    soulBackend, soulFrontend, soulDb,
    mindprint,
    mattermost, picoclaw, jenkins, redis,
  ] = await Promise.all([
    checkDocker('backend-blue').then(r => r || checkDocker('backend-green')),
    checkDocker('frontend-green').then(r => r || checkDocker('frontend-blue')),
    checkDocker('souloscope-postgres').then(r => r || checkDocker('astrocalc-blue')),
    check('http://localhost:4000/').catch(() => checkDocker('mindprint')),
    check('http://localhost:8065/api/v4/system/ping'),
    check('http://localhost:18790/health'),
    checkDocker('jenkins-automation'),
    checkDocker('mailu-redis'),
  ]);

  res.json({
    souloscope: {
      online: soulBackend && soulFrontend,
      services: { backend: soulBackend, frontend: soulFrontend, db: soulDb },
    },
    mindprint: {
      online: mindprint,
      services: { app: mindprint },
    },
    'qucogroup-com': {
      online: true, // this server itself is answering
      services: { mattermost, picoclaw, jenkins, redis },
    },
  });
});

// --- GET /api/tasks ---
app.get('/api/tasks', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- GET /api/system ---
app.get('/api/system', async (req, res) => {
  try {
    const events = await db.query('SELECT COUNT(*) as count FROM events');
    const tasks = await db.query('SELECT status, COUNT(*) as count FROM tasks GROUP BY status');
    res.json({
      total_events: parseInt(events.rows[0].count),
      tasks: tasks.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- GET /api/analytics ---
const { Pool: PgPool } = require('pg');

const soulDb = process.env.SOULOSCOPE_DATABASE_URL
  ? new PgPool({ connectionString: process.env.SOULOSCOPE_DATABASE_URL })
  : null;

async function safeQuery(pool, sql, fallback = { rows: [{}] }) {
  if (!pool) return fallback;
  try { return await pool.query(sql); } catch { return fallback; }
}

async function fetchGitHubIssues(repo) {
  if (!GITHUB_TOKEN || !repo) return { open: 0, closed: 0, bugs: [] };
  try {
    const [openRes, closedRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=10`, {
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
      }),
      fetch(`https://api.github.com/repos/${repo}/issues?state=closed&per_page=100`, {
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
      }),
    ]);
    const open = await openRes.json();
    const closed = await closedRes.json();
    return {
      open: Array.isArray(open) ? open.length : 0,
      closed: Array.isArray(closed) ? closed.length : 0,
      bugs: Array.isArray(open) ? open.slice(0, 5).map(i => ({
        number: i.number, title: i.title, severity: (i.labels||[]).map(l=>l.name).join(', ') || 'unknown', last_seen: i.updated_at
      })) : [],
    };
  } catch { return { open: 0, closed: 0, bugs: [] }; }
}

app.get('/api/analytics', async (req, res) => {
  try {
    const [soulUsers, soulOrders, soulSubs, soulBugQueue, ghIssues] = await Promise.all([
      safeQuery(soulDb, `SELECT COUNT(*) AS total, COUNT(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN 1 END) AS new_30d FROM users`),
      safeQuery(soulDb, `SELECT COUNT(*) AS total_orders, COALESCE(SUM(amount_subunit), 0) AS revenue_paise, COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN amount_subunit END), 0) AS mrr_paise FROM orders`),
      safeQuery(soulDb, `SELECT COUNT(CASE WHEN ends_at > NOW() THEN 1 END) AS active, COUNT(CASE WHEN ends_at BETWEEN NOW() - INTERVAL '30 days' AND NOW() THEN 1 END) AS churned FROM subscriptions`),
      safeQuery(soulDb, `SELECT COUNT(*) AS total, COUNT(CASE WHEN status='github_failed' THEN 1 END) AS failed, COUNT(CASE WHEN status='done' THEN 1 END) AS done FROM bug_report_queue`),
      fetchGitHubIssues(process.env.GITHUB_REPO_SOULOSCOPE || 'SkyDaddy001/souloscope2.0'),
    ]);

    const su = soulUsers.rows[0];
    const so = soulOrders.rows[0];
    const ss = soulSubs.rows[0];
    const bq = soulBugQueue.rows[0];

    const paise = (v) => `₹${(parseInt(v || 0) / 100).toFixed(0)}`;
    const soulChurnRate = parseInt(ss.active||0) > 0
      ? ((parseInt(ss.churned||0) / (parseInt(ss.active||0) + parseInt(ss.churned||0))) * 100).toFixed(1) + '%'
      : '0%';

    res.json({
      souloscope: {
        users: parseInt(su.total || 0),
        newUsers30d: parseInt(su.new_30d || 0),
        revenue: paise(so.revenue_paise),
        mrr: paise(so.mrr_paise),
        activeSubs: parseInt(ss.active || 0),
        churn: soulChurnRate,
        orders: parseInt(so.total_orders || 0),
        bugs: {
          queued: parseInt(bq.total || 0),
          openIssues: ghIssues.open,
          closedIssues: ghIssues.closed,
          recentBugs: ghIssues.bugs,
        },
      },
      mindprint: { users: 0, newUsers30d: 0, sessions: 0, sessions30d: 0, revenue: '₹0', mrr: '₹0', churn: '—' },
    });
  } catch (e) {
    console.error('Analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- POST /api/bug-report ---
// Sources: frontend JS errors, API failures, bot reports, health alerts
// Flow: create GitHub issue → post to #engineering → CEO dispatches eng_soul analysis
const _bugReportCooldowns = new Map();  // title → last report timestamp (dedup per 10min)
app.post('/api/bug-report', async (req, res) => {
  const {
    title,
    description = '',
    source = 'unknown',       // 'frontend' | 'devops' | 'bot' | 'api'
    project = 'company-os',   // 'souloscope' | 'mindprint' | 'company-os'
    severity = 'medium',      // 'critical' | 'high' | 'medium' | 'low'
    stack = '',
    url = '',
  } = req.body;

  if (!title) return res.status(400).json({ error: 'title required' });
  const cooldownKey = title.slice(0, 80);
  const lastSeen = _bugReportCooldowns.get(cooldownKey) || 0;
  if (Date.now() - lastSeen < 10 * 60 * 1000) {
    return res.json({ ok: true, skipped: 'duplicate within 10min' });
  }
  _bugReportCooldowns.set(cooldownKey, Date.now());

  const repo = GITHUB_REPOS[project] || GITHUB_REPOS['company-os'];
  const labels = ['bug', severity, source].filter(Boolean);

  const issueBody = [
    `## Bug Report`,
    `**Source:** ${source}  **Severity:** ${severity}  **Project:** ${project}`,
    url ? `**URL:** ${url}` : '',
    '',
    `### Description`,
    description,
    stack ? `\n### Stack Trace\n\`\`\`\n${stack.slice(0, 2000)}\n\`\`\`` : '',
    '',
    `---`,
    `*Filed automatically by QucoGroup Company OS*`,
  ].filter(s => s !== null).join('\n');

  // Create GitHub issue
  const issue = await createGithubIssue(repo, `[${severity.toUpperCase()}] ${title}`, issueBody, labels);

  // Log event
  await publishEvent('bug.reported', `eng_soul`, title, issue.url || issue.error || '');

  // Post to project channel + escalate critical/high to #boss
  const severityEmoji = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' }[severity] || '⚪';
  const bugChannel = project === 'souloscope' ? CH_SOULOSCOPE : CH_QUCOGROUP;
  await postToMattermost(bugChannel,
    `${severityEmoji} **Bug Report** [${severity.toUpperCase()}] — ${source}\n` +
    `**${title}**\n` +
    (description ? `> ${description.slice(0, 200)}\n` : '') +
    (issue.url ? `📎 [GitHub #${issue.number}](${issue.url})` : `⚠️ GitHub error: ${issue.error}`)
  );

  if (severity === 'critical' || severity === 'high') {
    await postToMattermost(CH_BOSS,
      `${severityEmoji} **${severity.toUpperCase()} BUG** in ${project}: ${title}\n` +
      (issue.url ? `📎 [GitHub #${issue.number}](${issue.url})` : '')
    );
  }

  res.json({ ok: true, issue_url: issue.url, issue_number: issue.number });
});

// Docker status — called by agents via exec("curl http://localhost:3001/api/docker-status")
app.get('/api/docker-status', (req, res) => {
  exec("docker ps --format '{{.Names}}|{{.Status}}|{{.Image}}'", (err, stdout) => {
    if (err) return res.status(500).json({ error: 'docker ps failed', detail: err.message });
    const containers = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [name, status, image] = line.split('|');
      const healthy = status?.includes('healthy');
      const up      = status?.toLowerCase().startsWith('up');
      return { name, status, image, healthy, up };
    });
    const unhealthy = containers.filter(c => c.up && !c.healthy && c.status?.includes('('));
    res.json({
      ts: new Date().toISOString(),
      total: containers.length,
      healthy: containers.filter(c => c.healthy).length,
      unhealthy: unhealthy.length,
      containers,
    });
  });
});

// Jenkins proxy — agents call curl http://172.17.0.1:3001/api/jenkins/...
// GET  /api/jenkins/jobs            → list all jobs + last build status
// POST /api/jenkins/build/:job      → trigger build (body: {branch:"main"})
// GET  /api/jenkins/build/:job/last → last build status
const JENKINS_URL   = 'http://10.0.0.61:8080';
const JENKINS_CREDS = 'pico-agent:11219768fa475aefe42120f0ec65d23cd5';
const JENKINS_AUTH  = 'Basic ' + Buffer.from(JENKINS_CREDS).toString('base64');

async function jenkinsGet(path) {
  const r = await fetch(`${JENKINS_URL}${path}`, { headers: { Authorization: JENKINS_AUTH } });
  if (!r.ok) throw new Error(`Jenkins ${r.status} at ${path}`);
  return r.json();
}

async function jenkinsPost(path, body = '') {
  const crumbData = await fetch(`${JENKINS_URL}/crumbIssuer/api/json`, { headers: { Authorization: JENKINS_AUTH } }).then(r => r.json());
  const r = await fetch(`${JENKINS_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: JENKINS_AUTH, [crumbData.crumbRequestField]: crumbData.crumb, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return r.status;
}

app.get('/api/jenkins/jobs', async (req, res) => {
  try {
    const data = await jenkinsGet('/api/json?tree=jobs[name,color,url,lastBuild[number,result,timestamp,duration]]');
    res.json(data.jobs || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/jenkins/build/:job/last', async (req, res) => {
  try {
    const job = encodeURIComponent(req.params.job);
    const data = await jenkinsGet(`/job/${job}/api/json?tree=lastBuild[number,result,timestamp,duration,displayName],name,color`);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/jenkins/build/:job', async (req, res) => {
  try {
    const job    = encodeURIComponent(req.params.job);
    const branch = (req.body?.branch || 'main').replace(/[^a-zA-Z0-9._/-]/g, '');
    const status = await jenkinsPost(`/job/${job}/job/${branch}/build`);
    res.json({ triggered: status === 201 || status === 200, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mattermost search — agents call curl "http://172.17.0.1:3001/api/mm/search?q=..."
// GET /api/mm/search?q=<query>&channel=<id>   → search posts
// GET /api/mm/channel/:id/posts?limit=20       → recent posts in a channel
app.get('/api/mm/search', async (req, res) => {
  const q       = req.query.q || '';
  const channel = req.query.channel || '';
  if (!q) return res.status(400).json({ error: 'q param required' });
  try {
    const body = { terms: q, is_or_search: false };
    if (channel) body.channel_ids = [channel];
    const r = await fetch(`${MM_URL}/api/v4/posts/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${MM_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    const posts = (data.order || []).slice(0, 20).map(id => ({
      id, message: data.posts[id]?.message, create_at: data.posts[id]?.create_at,
      channel_id: data.posts[id]?.channel_id,
    }));
    res.json({ count: posts.length, posts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/mm/channel/:id/posts', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  try {
    const r = await fetch(`${MM_URL}/api/v4/channels/${req.params.id}/posts?per_page=${limit}`, {
      headers: { Authorization: `Bearer ${MM_BOT_TOKEN}` },
    });
    const data = await r.json();
    const posts = (data.order || []).map(id => ({
      id, message: data.posts[id]?.message, create_at: data.posts[id]?.create_at,
    }));
    res.json({ count: posts.length, posts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SPA fallback — must be after all API routes
app.get('/{*splat}', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'dist', 'index.html'));
});

app.listen(3001, () => console.log('Company OS server on :3001'));
