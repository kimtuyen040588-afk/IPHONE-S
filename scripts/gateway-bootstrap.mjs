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

async function fullXcodeInstalled() {
    const result = await capture('/usr/bin/xcodebuild', ['-version']);
    return result.ok && /^Xcode\s+\d/m.test(result.output);
}

async function dockerInstalled() {
    return commandExists('docker', ['--version']);
}

async function dockerRunning() {
    return commandExists('docker', ['info', '--format', '{{.ServerVersion}}']);
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
    const [xcode, dockerApp, docker, driver, apple] = await Promise.all([
        fullXcodeInstalled(),
        dockerInstalled(),
        dockerRunning(),
        exists(path.join(root, '.appium2/node_modules/appium-xcuitest-driver')),
        signingStatus(),
    ]);
    return {
        mac: process.platform === 'darwin',
        node: Number(process.versions.node.split('.')[0]) >= 22,
        xcode,
        docker,
        driver,
        apple,
        environment: {
            xcode: xcode ? 'ready' : 'missing',
            docker: docker ? 'ready' : dockerApp ? 'not-running' : 'missing',
            driver: driver ? 'ready' : 'missing',
        },
    };
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

async function prepareEnvironment() {
    const current = await status();
    console.log('\n环境助手正在处理…');
    if (!current.xcode) {
        console.log('• 缺少完整 Xcode：已打开 Apple 官方下载页。安装完成后回到本程序点“重新检查”。');
        await run('/usr/bin/open', ['https://developer.apple.com/xcode/']);
    } else {
        console.log('✓ Xcode 已就绪');
    }
    if (current.environment.docker === 'missing') {
        console.log('• 缺少 Docker Desktop：已打开 Docker 官方下载页。安装后请启动一次 Docker。');
        await run('/usr/bin/open', ['https://www.docker.com/products/docker-desktop/']);
    } else if (current.environment.docker === 'not-running') {
        console.log('• Docker 已安装但尚未启动：正在为你打开 Docker。等菜单栏图标显示运行后，再点“重新检查”。');
        await run('/usr/bin/open', ['-a', 'Docker']);
    } else {
        console.log('✓ Docker Desktop 已运行');
    }
    if (!current.driver) {
        console.log('• 内置 iPhone 控制驱动不完整。请重新下载完整的网关安装包；它本来会随程序一起带好。');
    } else {
        console.log('✓ iPhone 控制驱动已就绪');
    }
    console.log('\n已处理能自动处理的项目。Apple 和 Docker 的安装确认必须由你在官方界面点一次，这是 macOS 的安全规定。');
}

if (!['doctor', 'install', 'prepare-environment', 'status'].includes(action)) {
    console.error('用法：node scripts/gateway-bootstrap.mjs doctor | install | prepare-environment | status');
    process.exitCode = 1;
} else if (action === 'status') {
    console.log(JSON.stringify(await status()));
} else if (action === 'doctor') {
    if (!await doctor()) process.exitCode = 1;
} else if (action === 'prepare-environment') {
    await prepareEnvironment();
} else {
    await install();
}
