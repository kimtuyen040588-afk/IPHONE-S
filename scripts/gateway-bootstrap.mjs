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

async function doctor() {
    const checks = [
        { label: '这台电脑是 Mac', ok: process.platform === 'darwin', required: true },
        { label: '内置 Node.js 已就绪', ok: Number(process.versions.node.split('.')[0]) >= 22, required: true },
        { label: 'Xcode 已安装', ok: await commandExists('xcode-select', ['-p']), required: true },
        { label: 'Docker Desktop 已启动', ok: await commandExists('docker', ['compose', 'version']), required: true },
        { label: 'iPhone 控制驱动已准备好', ok: await exists(path.join(root, '.appium2/node_modules/appium-xcuitest-driver')), required: false },
        { label: 'Apple 开发团队已选择', ok: Boolean(process.env.XCODE_ORG_ID) || await envHasTeam(), required: false },
    ];
    console.log('\nMac 网关检查结果');
    for (const check of checks) console.log(`${check.ok ? '✓' : '✗'} ${check.label}${!check.ok && check.required ? '（需要处理）' : ''}`);
    const ready = checks.every((check) => !check.required || check.ok);
    console.log(ready ? '\n基础环境可用。下一步可点“准备本机网关”。' : '\n请先处理标有“需要处理”的项目，再点一次“重新检查”。');
    return ready;
}

async function ensureEnv() {
    const target = path.join(root, '.env');
    if (await exists(target)) return;
    const template = await readFile(path.join(root, '.env.example'), 'utf8');
    const password = randomBytes(24).toString('base64url');
    const body = template
        .replace('DATABASE_URL=postgresql://phone_farm:CHANGE_ME@127.0.0.1:5432/phone_farm', `DATABASE_URL=postgresql://phone_farm:${password}@127.0.0.1:5432/phone_farm`)
        .replace('POSTGRES_PASSWORD=CHANGE_ME', `POSTGRES_PASSWORD=${password}`);
    await writeFile(target, body, { mode: 0o600 });
    await chmod(target, 0o600);
    console.log('✓ 已为这台 Mac 创建私有配置文件');
}

async function install() {
    if (!await doctor()) { process.exitCode = 1; return; }
    await ensureEnv();
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

if (!['doctor', 'install'].includes(action)) {
    console.error('用法：node scripts/gateway-bootstrap.mjs doctor | install');
    process.exitCode = 1;
} else if (action === 'doctor') {
    if (!await doctor()) process.exitCode = 1;
} else {
    await install();
}
