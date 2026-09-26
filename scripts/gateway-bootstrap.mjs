#!/usr/bin/env node

/**
 * The non-technical setup path used by the macOS Gateway app.
 * Apple account sign-in and 2FA stay inside Xcode's own UI.
 */
import { randomBytes } from 'node:crypto';
import { access, chmod, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.PHONE_FARM_HOME
    ? path.resolve(process.env.PHONE_FARM_HOME)
    : path.resolve(scriptDirectory, '..');
const action = process.argv[2] ?? 'doctor';

function run(command, args, options = {}) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { cwd: root, ...options });
        child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
        child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
        child.once('error', () => resolve(false));
        child.once('exit', (code) => resolve(code === 0));
    });
}

function capture(command, args) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.once('error', () => resolve({ ok: false, output }));
        child.once('exit', (code) => resolve({ ok: code === 0, output }));
    });
}

async function exists(target) {
    try { await access(target); return true; } catch { return false; }
}

async function commandExists(command, args = ['--version']) {
    return run(command, args, { stdio: ['ignore', 'ignore', 'ignore'] });
}

async function envHasTeam() {
    try {
        const body = await readFile(path.join(root, '.env'), 'utf8');
        return /^XCODE_ORG_ID=(?!replace-me$).+/m.test(body);
    } catch { return false; }
}

async function signingStatus() {
    const result = await capture('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
    const match = result.output.match(/Apple Development:[^(]+\(([A-Z0-9]{10})\)/);
    if (match) return { state: 'ready', teamId: match[1], message: 'Apple 开发者账号和签名已就绪' };
    if (await envHasTeam()) return { state: 'needs-signing', message: '已找到团队设置，但还没有可用的 Apple Development 签名' };
    return { state: 'needs-login', message: '请在 Xcode → Settings → Accounts 登录 Apple Developer 账号' };
}

async function status() {
    const [xcode, docker, driver, apple] = await Promise.all([
        commandExists('xcode-select', ['-p']),
        commandExists('docker', ['compose', 'version']),
        exists(path.join(root, '.appium2/node_modules/appium-xcuitest-driver')),
        signingStatus(),
    ]);
    return { mac: process.platform === 'darwin', node: Number(process.versions.node.split('.')[0]) >= 22, xcode, docker, driver, apple };
}

async function doctor() {
    const current = await status();
    const checks = [
        { label: '这台电脑是 Mac', ok: current.mac, required: true },
        { label: '内置 Node.js 已就绪', ok: current.node, required: true },
        { label: 'Xcode 已安装', ok: current.xcode, required: true },
        { label: 'Docker Desktop 已启动', ok: current.docker, required: true },
        { label: 'iPhone 控制驱动已准备好', ok: current.driver, required: false },
        { label: current.apple.message, ok: current.apple.state === 'ready', required: false },
    ];
    console.log('\nMac 网关检查结果');
    for (const check of checks) console.log(`${check.ok ? '✓' : '✗'} ${check.label}${!check.ok && check.required ? '（需要处理）' : ''}`);
    const ready = checks.every((check) => !check.required || check.ok);
    console.log(ready ? '\n基础环境可用。下一步可点“准备本机网关”。' : '\n请先处理标有“需要处理”的项目，再点一次“重新检查”。');
    return ready;
}

async function ensureEnv(teamId) {
    const target = path.join(root, '.env');
    let body;
    if (await exists(target)) body = await readFile(target, 'utf8');
    else {
        const template = await readFile(path.join(root, '.env.example'), 'utf8');
        const password = randomBytes(24).toString('base64url');
        body = template
            .replace('DATABASE_URL=postgresql://phone_farm:CHANGE_ME@127.0.0.1:5432/phone_farm', `DATABASE_URL=postgresql://phone_farm:${password}@127.0.0.1:5432/phone_farm`)
            .replace('POSTGRES_PASSWORD=CHANGE_ME', `POSTGRES_PASSWORD=${password}`);
    }
    body = body.replace(/^XCODE_ORG_ID=.*$/m, `XCODE_ORG_ID=${teamId}`);
    await writeFile(target, body, { mode: 0o600 });
    await chmod(target, 0o600);
    console.log('✓ 已保存这台 Mac 的私有配置和 Apple 开发团队');
}

async function install() {
    if (!await doctor()) { process.exitCode = 1; return; }
    const apple = await signingStatus();
    if (apple.state !== 'ready') {
        console.error(`\n还不能继续：${apple.message}`);
        console.error('请在 Xcode 完成登录后，回到这里点“重新检查”。');
        process.exitCode = 1;
        return;
    }
    await ensureEnv(apple.teamId);
    if (!await exists(path.join(root, 'node_modules/appium'))) {
        console.log('\n正在准备网关程序，第一次约需几分钟…');
        if (!await run(process.execPath, ['--run', 'npm', 'ci'])) { process.exitCode = 1; return; }
    }
    if (!await exists(path.join(root, '.appium2/node_modules/appium-xcuitest-driver'))) {
        console.log('\n正在准备 iPhone 控制驱动，第一次约需几分钟…');
        if (!await run(process.execPath, ['--run', 'npm', 'run', 'appium:install-driver'])) { process.exitCode = 1; return; }
    }
    console.log('\n正在建立本机数据库…');
    if (!await run(process.execPath, ['--run', 'npm', 'run', 'db:setup'])) { process.exitCode = 1; return; }
    console.log('\n✓ 这台 Mac 的网关已准备好。请在 Xcode 官方界面登录 Apple 开发者账号，再连接第一台 iPhone。');
}

if (!['doctor', 'install', 'status'].includes(action)) {
    console.error('用法：node scripts/gateway-bootstrap.mjs doctor | install | status');
    process.exitCode = 1;
} else if (action === 'status') {
    console.log(JSON.stringify(await status()));
} else if (action === 'doctor') {
    if (!await doctor()) process.exitCode = 1;
} else {
    await install();
}
