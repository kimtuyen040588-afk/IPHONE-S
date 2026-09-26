import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const envPath = path.join(root, '.env');
const nginxSnippet = '/etc/nginx/snippets/data-statistics-v2-routes.conf';
const begin = '# BEGIN PHONE FARM RELAY';
const end = '# END PHONE FARM RELAY';

function random() { return crypto.randomBytes(32).toString('hex'); }

async function ensureEnv() {
  try {
    await readFile(envPath, 'utf8');
    console.log('Existing relay secrets kept in .env');
    return;
  } catch { /* first installation */ }
  const value = [
    'PUBLIC_ORIGIN=https://hgykny55888.it.com',
    'PORT=4310',
    `DATABASE_URL=postgresql://phone_farm_relay:${random()}@postgres:5432/phone_farm_relay`,
    `RELAY_CONSOLE_TOKEN=${random()}`,
    `POSTGRES_PASSWORD=${random()}`,
    '',
  ].join('\n');
  await writeFile(envPath, value, { mode: 0o600, flag: 'wx' });
  await chmod(envPath, 0o600);
  console.log('Created private relay secrets in .env');
}

async function configureNginx() {
  const original = await readFile(nginxSnippet, 'utf8');
  if (original.includes(begin)) {
    console.log('Nginx relay route already exists');
    return;
  }
  const route = `${begin}\nlocation ^~ /phone-farm-api/ {\n    proxy_pass http://127.0.0.1:4310/;\n    proxy_http_version 1.1;\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_set_header X-Forwarded-Proto $scheme;\n    proxy_connect_timeout 10s;\n    proxy_read_timeout 60s;\n    proxy_send_timeout 60s;\n}\n${end}\n\n`;
  const backup = `${nginxSnippet}.pre-phone-farm-relay-${Date.now()}`;
  await copyFile(nginxSnippet, backup);
  await writeFile(nginxSnippet, `${route}${original}`);
  try {
    execFileSync('nginx', ['-t'], { stdio: 'inherit' });
    execFileSync('systemctl', ['reload', 'nginx'], { stdio: 'inherit' });
    console.log('Added HTTPS relay route at /phone-farm-api/');
  } catch (error) {
    await rename(backup, nginxSnippet);
    throw error;
  }
}

await mkdir(root, { recursive: true });
await ensureEnv();
await configureNginx();
