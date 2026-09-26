import crypto from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';

const { Pool } = pg;
const port = Number(process.env.PORT || 4310);
const consoleToken = process.env.RELAY_CONSOLE_TOKEN;
const publicOrigin = (process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '');

if (!consoleToken || consoleToken === 'CHANGE_ME') {
  throw new Error('RELAY_CONSOLE_TOKEN must be set to a long random value');
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
const taskSignals = new Map();

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function secureEqual(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bearer(request) {
  return request.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
}

async function requireConsole(request, reply) {
  if (!secureEqual(bearer(request), consoleToken)) {
    return reply.code(401).send({ error: 'A private console token is required.' });
  }
}

async function gatewayFor(request, reply) {
  const token = bearer(request);
  if (!token) {
    reply.code(401).send({ error: 'Gateway token is required.' });
    return null;
  }
  const { rows } = await pool.query(
    'SELECT id, label, disabled FROM gateways WHERE token_hash = $1', [digest(token)],
  );
  const gateway = rows[0];
  if (!gateway || gateway.disabled) {
    reply.code(401).send({ error: 'Gateway is not enrolled or has been disabled.' });
    return null;
  }
  return gateway;
}

function recipientsFrom(value) {
  if (!Array.isArray(value)) return [];
  const unique = [...new Set(value.map((item) => String(item).trim()))];
  if (!unique.length || unique.some((number) => !/^\+[1-9]\d{6,14}$/.test(number))) {
    throw new Error('Recipients must be unique international-format phone numbers.');
  }
  return unique;
}

function signalFor(gatewayId) {
  let signal = taskSignals.get(gatewayId);
  if (!signal) {
    signal = { sequence: 0, waiters: new Set() };
    taskSignals.set(gatewayId, signal);
  }
  return signal;
}

function notifyGateway(gatewayId) {
  const signal = signalFor(gatewayId);
  signal.sequence += 1;
  for (const resolve of signal.waiters) resolve();
  signal.waiters.clear();
}

async function waitForTask(gatewayId, observedSequence, timeoutMs = 25_000) {
  const signal = signalFor(gatewayId);
  if (signal.sequence !== observedSequence) return;
  await new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.waiters.delete(finish); resolve(); };
    const timer = setTimeout(finish, timeoutMs);
    signal.waiters.add(finish);
  });
}

async function leaseNextTask(gatewayId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE tasks SET status = 'queued', leased_until = NULL
      WHERE gateway_id = $1 AND status = 'leased' AND leased_until < now()`, [gatewayId]);
    const { rows } = await client.query(`SELECT * FROM tasks WHERE gateway_id = $1 AND status = 'queued'
      ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`, [gatewayId]);
    const task = rows[0];
    if (!task) { await client.query('COMMIT'); return null; }
    await client.query(`UPDATE tasks SET status = 'leased', leased_until = now() + interval '10 minutes' WHERE id = $1`, [task.id]);
    await client.query('COMMIT');
    return task;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gateways (
      id uuid PRIMARY KEY,
      label text NOT NULL,
      token_hash text NOT NULL UNIQUE,
      disabled boolean NOT NULL DEFAULT false,
      client_version text,
      device_count integer NOT NULL DEFAULT 0,
      last_seen_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id uuid PRIMARY KEY,
      gateway_id uuid REFERENCES gateways(id),
      status text NOT NULL CHECK (status IN ('queued', 'leased', 'submitted', 'manual_review', 'cancelled')),
      payload jsonb NOT NULL,
      content_summary text NOT NULL,
      recipient_count integer NOT NULL,
      leased_until timestamptz,
      submitted_at timestamptz,
      result_reason text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS tasks_available_idx ON tasks (gateway_id, status, created_at);
  `);
}

app.addHook('onRequest', async (request, reply) => {
  const origin = request.headers.origin?.replace(/\/$/, '');
  if (origin && publicOrigin && origin === publicOrigin) {
    reply.header('access-control-allow-origin', origin);
    reply.header('access-control-allow-headers', 'authorization, content-type');
    reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
    reply.header('vary', 'Origin');
  }
  if (request.method === 'OPTIONS') return reply.code(204).send();
});

app.get('/health', async () => ({ ok: true, service: 'phone-farm-relay' }));

app.get('/v1/overview', { preHandler: requireConsole }, async () => {
  const [gateways, tasks] = await Promise.all([
    pool.query(`SELECT id, label, client_version, device_count, last_seen_at, created_at,
      CASE WHEN last_seen_at > now() - interval '90 seconds' THEN 'online' ELSE 'offline' END AS state
      FROM gateways WHERE NOT disabled ORDER BY created_at ASC`),
    pool.query(`SELECT status, count(*)::int AS count FROM tasks GROUP BY status`),
  ]);
  return { gateways: gateways.rows, tasks: tasks.rows };
});

app.post('/v1/gateways', { preHandler: requireConsole }, async (request, reply) => {
  const label = String(request.body?.label || '').trim().slice(0, 80);
  if (!label) return reply.code(400).send({ error: 'Gateway label is required.' });
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO gateways (id, label, token_hash) VALUES ($1, $2, $3)', [id, label, digest(token)]);
  return reply.code(201).send({ id, label, gatewayToken: token });
});

app.post('/v1/gateway/heartbeat', async (request, reply) => {
  const gateway = await gatewayFor(request, reply);
  if (!gateway) return;
  const deviceCount = Number(request.body?.deviceCount ?? 0);
  const clientVersion = String(request.body?.clientVersion || '').trim().slice(0, 80) || null;
  if (!Number.isInteger(deviceCount) || deviceCount < 0 || deviceCount > 500) {
    return reply.code(400).send({ error: 'deviceCount must be an integer between 0 and 500.' });
  }
  await pool.query(
    'UPDATE gateways SET client_version = $1, device_count = $2, last_seen_at = now() WHERE id = $3',
    [clientVersion, deviceCount, gateway.id],
  );
  return { ok: true, pollAfterSeconds: 10 };
});

app.post('/v1/tasks', { preHandler: requireConsole }, async (request, reply) => {
  if (request.body?.confirmed !== true) {
    return reply.code(400).send({ error: 'A task must be manually confirmed before it can be queued.' });
  }
  const gatewayId = String(request.body?.gatewayId || '');
  const message = String(request.body?.message || '');
  const recipients = recipientsFrom(request.body?.recipients);
  if (!message.trim() || message.length > 4000) return reply.code(400).send({ error: 'Message must contain 1–4000 characters.' });
  const gateway = await pool.query('SELECT id FROM gateways WHERE id = $1 AND NOT disabled', [gatewayId]);
  if (!gateway.rows[0]) return reply.code(404).send({ error: 'Selected gateway was not found.' });
  const id = crypto.randomUUID();
  const summary = crypto.createHash('sha256').update(message).digest('hex').slice(0, 12);
  await pool.query(
    `INSERT INTO tasks (id, gateway_id, status, payload, content_summary, recipient_count)
     VALUES ($1, $2, 'queued', $3::jsonb, $4, $5)`,
    [id, gatewayId, JSON.stringify({ recipients, message, attachmentUrl: request.body?.attachmentUrl || null }), summary, recipients.length],
  );
  notifyGateway(gatewayId);
  return reply.code(201).send({ id, status: 'queued', recipientCount: recipients.length, contentSummary: summary });
});

app.get('/v1/gateway/next-task', async (request, reply) => {
  const gateway = await gatewayFor(request, reply);
  if (!gateway) return;
  const signal = signalFor(gateway.id);
  let task = await leaseNextTask(gateway.id);
  if (!task) {
    // The Mac keeps one request open for up to 25 seconds.  A newly created
    // task wakes it immediately, while an idle fleet makes no rapid-fire
    // polling requests.
    await waitForTask(gateway.id, signal.sequence);
    task = await leaseNextTask(gateway.id);
  }
  if (!task) return reply.code(204).send();
  return { id: task.id, payload: task.payload, leaseSeconds: 600 };
});

app.post('/v1/gateway/tasks/:id/result', async (request, reply) => {
  const gateway = await gatewayFor(request, reply);
  if (!gateway) return;
  const status = request.body?.status;
  if (!['submitted', 'manual_review'].includes(status)) return reply.code(400).send({ error: 'Invalid result status.' });
  const reason = String(request.body?.reason || '').trim().slice(0, 500) || null;
  const result = await pool.query(`UPDATE tasks SET status = $1, submitted_at = now(), result_reason = $2
    WHERE id = $3 AND gateway_id = $4 AND status = 'leased'`, [status, reason, request.params.id, gateway.id]);
  if (!result.rowCount) return reply.code(404).send({ error: 'Leased task not found.' });
  return { ok: true };
});

await migrate();
app.addHook('onClose', async () => { await pool.end(); });
await app.listen({ host: '0.0.0.0', port });
