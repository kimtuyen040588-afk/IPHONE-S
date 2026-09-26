#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const mode = process.argv[2] ?? 'check';
const ok = '✓';
const bad = '✗';

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: 'ignore', ...options });
    child.once('error', () => resolve({ ok: false, code: -1 }));
    child.once('exit', (code) => resolve({ ok: code === 0, code: code ?? -1 }));
  });
}

async function exists(relativePath) {
  try { await access(path.join(root, relativePath)); return true; } catch { return false; }
}

async function envValue(name) {
  try {
    const body = await readFile(path.join(root, '.env'), 'utf8');
    const line = body.split(/\r?\n/).find((item) => item.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim();
  } catch { return undefined; }
}

async function check() {
  const results = [];
  const mac = process.platform === 'darwin';
  results.push({ required: true, pass: mac, label: '这台电脑是 Mac' });
  const xcode = mac ? await run('xcode-select', ['-p']) : { ok: false };
  results.push({ required: true, pass: xcode.ok, label: 'Xcode 命令工具已准备好' });
  results.push({ required: true, pass: await exists('node_modules/appium'), label: '手机控制程序已安装' });
  results.push({ required: true, pass: await exists('.appium2/node_modules/appium-xcuitest-driver'), label: 'iPhone 控制驱动已安装' });
  const docker = await run('docker', ['compose', 'version']);
  results.push({ required: true, pass: docker.ok, label: '本机数据库工具已准备好' });
  const team = await envValue('XCODE_ORG_ID');
  results.push({ required: false, pass: Boolean(team && team !== 'replace-me'), label: 'Apple 开发者签名已填写（连接真机前需要）' });

  console.log('\n设备助手检查结果');
  for (const result of results) console.log(`${result.pass ? ok : bad} ${result.label}${!result.pass && result.required ? '（需要处理）' : ''}`);
  const missing = results.filter((result) => result.required && !result.pass);
  if (missing.length) {
    console.log('\n还不能启动。先处理上面标有“需要处理”的项目，然后再运行：npm run assistant:check');
    return false;
  }
  if (!team || team === 'replace-me') console.log('\n提示：Mac 已能启动后台；真正给 iPhone 安装设备助手前，还需要填写 Apple 开发者签名。');
  else console.log('\n基础环境已准备好。接上 iPhone 后，可以运行：npm run assistant:start');
  return true;
}

function startService(label, script) {
  const child = spawn('npm', ['run', script], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (chunk) => process.stdout.write(`[${label}] ${chunk}`);
  child.stdout.on('data', write);
  child.stderr.on('data', write);
  child.on('error', (error) => process.stdout.write(`[${label}] 无法启动：${error.message}\n`));
  return child;
}

async function start() {
  if (!await check()) process.exitCode = 1;
  else {
    console.log('\n正在启动固定 Mac 的设备助手。保持这个窗口开着；按 Ctrl+C 会安全停止。\n');
    const database = await run('docker', ['compose', 'up', '-d', '--wait', 'postgres'], { stdio: 'inherit' });
    if (!database.ok) {
      console.log('\n数据库没有启动成功，设备助手没有继续启动。');
      process.exitCode = 1;
      return;
    }
    const services = [
      startService('手机控制', 'appium'),
      startService('连接管理', 'wda:service'),
      startService('任务后台', 'worker'),
      startService('网页接口', 'web'),
    ];
    const stop = () => {
      console.log('\n正在停止设备助手…');
      for (const child of services) child.kill('SIGTERM');
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await Promise.all(services.map((child) => new Promise((resolve) => child.once('exit', resolve))));
  }
}

if (!['check', 'start'].includes(mode)) {
  console.log('用法：npm run assistant:check 或 npm run assistant:start');
  process.exitCode = 1;
} else if (mode === 'check') {
  if (!await check()) process.exitCode = 1;
} else {
  await start();
}
