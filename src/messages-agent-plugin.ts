import crypto from 'node:crypto';

import type { PhoneFarmPlugin, TaskDefinition } from './plugin.js';
import type { JsonObject, JsonValue } from './types.js';
import { createObservePlan } from './agent/safety.js';
import { createBatchPreview } from './messages/batch.js';
import { configuredScreenPlanner } from './agent/planner.js';

const PLUGIN_ID = 'com.phone-farm.messages-agent';
const MESSAGES_BUNDLE_ID = 'com.apple.MobileSMS';

interface InspectMessagesPayload extends JsonObject {
    requestId: string;
}

function requireObject(value: JsonValue): JsonObject {
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Payload must be an object');
    return value;
}

function validateRequestId(value: JsonValue | undefined): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
        throw new Error('requestId must be 1–128 letters, numbers, periods, underscores, or hyphens');
    }
    return value;
}

const inspectMessagesTask: TaskDefinition<InspectMessagesPayload> = {
    type: 'inspect-messages',
    version: 1,
    displayName: 'Agent inspection: Messages (read-only)',
    validate(value) {
        const payload = requireObject(value);
        return { requestId: validateRequestId(payload.requestId) };
    },
    summarize: () => 'Agent inspection · Messages · no message sent',
    estimateDurationMs: () => 8_000,
    retryPolicy: () => ({ retryLimit: 1, retryDelaySeconds: 15, retryBackoff: false }),
    supportsStop: () => true,
    async execute(context, payload) {
        const plan = createObservePlan(context.device.udid, payload.requestId);
        try {
            await context.log(`Agent observation ${plan.requestId}: opening Messages. No recipient, text, image, or Send action is available to the agent.`);
            await context.automation.activateApp(MESSAGES_BUNDLE_ID);
            await context.automation.pause(1_500, context.signal);
            const screenshot = await context.automation.screenshot();
            const screenSha256 = crypto.createHash('sha256').update(screenshot).digest('hex');
            await context.log(`Agent observation ${plan.requestId}: screen captured (${screenshot.length} bytes, sha256 ${screenSha256}). Screenshot is not retained by this task.`);
            const planner = configuredScreenPlanner();
            if (!planner) {
                await context.log(`Agent observation ${plan.requestId}: cloud screen analysis is disabled. Set AGENT_PLANNER_URL and AGENT_ALLOW_SCREEN_UPLOAD=true only if you choose to share screenshots with a configured model.`);
            } else {
                const assessment = await planner.assessMessagesScreen(screenshot);
                // Do not persist the model's free-text note: a misbehaving model
                // could echo screen content. Persist only a constrained state.
                await context.log(`Agent observation ${plan.requestId}: planner readiness=${assessment.readiness}. Review the live device screen before any future dispatch.`);
            }
            await context.log(`Agent observation ${plan.requestId}: ready for human review or a future deterministic approved-message dispatcher.`);
            return { exitCode: 0, stopped: false };
        } catch (error) {
            if (context.signal.aborted) return { exitCode: null, stopped: true };
            return { exitCode: null, stopped: false, error: error instanceof Error ? error.message : String(error) };
        }
    },
};

function escapeHtml(value: unknown): string {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character] ?? character);
}

/**
 * First usable Agent surface: start a read-only observation of a chosen
 * device. It deliberately has no recipient, body, image, or send button.
 */
export function createMessagesAgentPlugin(): PhoneFarmPlugin {
    return {
        id: PLUGIN_ID,
        version: '0.1.0',
        displayName: 'Messages Agent (safe observation)',
        tasks: [inspectMessagesTask],
        navLinks: [{ label: 'Agent', href: '/agent', order: 10 }],
        registerRoutes(context) {
            context.app.get('/agent', async (_request, reply) => {
                const devices = (await context.loadDevices()).filter((device) => !device.disabled);
                const options = devices.map((device) => `<option value="${escapeHtml(device.udid)}">${escapeHtml(device.name)}</option>`).join('');
                return reply.type('text/html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>消息 Agent</title><style>body{font:16px system-ui,sans-serif;background:#f6f7f9;color:#17202a;margin:0}main{max-width:720px;margin:48px auto;padding:0 20px}.card{background:#fff;border:1px solid #dde2e8;border-radius:12px;padding:24px}select,button{font:inherit;padding:10px;border-radius:7px}select{min-width:240px;border:1px solid #cbd5e1}button{background:#2563eb;color:#fff;border:0;cursor:pointer;margin-left:8px}.note{color:#475569;line-height:1.65}.result{margin-top:16px;white-space:pre-wrap}</style></head><body><main><p><a href="/">← 设备</a></p><section class="card"><h1>消息 Agent · 安全观察模式</h1><p class="note">这一步只会打开 iPhone 的「信息」并拍一张临时屏幕快照，帮助确认手机是不是在正确状态。它不会读取或保存短信全文，不会输入号码、文字、图片，更不会点发送。</p>${devices.length ? `<label>选择设备　<select id="device">${options}</select></label><button id="inspect">开始检查</button><div id="result" class="result"></div><script>document.getElementById('inspect').onclick=async function(){const b=this;b.disabled=true;const r=document.getElementById('result');r.textContent='正在加入检查任务…';const response=await fetch('${context.routePrefix}/inspect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({udid:document.getElementById('device').value})});const data=await response.json().catch(()=>({}));r.textContent=response.ok?'已加入任务。到“设备”页查看执行日志。':'失败：'+(data.error||'未知错误');b.disabled=false}</script>` : '<p class="note">还没有已启用的设备。先到设备页完成第一台 iPhone 的注册和 WDA 配置。</p>'}</section></main></body></html>`);
            });
            context.app.post<{ Body: { udid?: string } }>(`${context.routePrefix}/inspect`, async (request, reply) => {
                const device = (await context.loadDevices()).find((candidate) => candidate.udid === request.body.udid);
                if (!device) return reply.code(404).send({ error: 'Device not found' });
                if (device.disabled) return reply.code(409).send({ error: 'This device is disabled' });
                const schedule = await context.scheduler.createTask({
                    deviceUdid: device.udid,
                    task: { pluginId: PLUGIN_ID, taskType: 'inspect-messages', taskVersion: 1, payload: { requestId: crypto.randomUUID() } },
                    timing: { kind: 'now' }, runWindowMinutes: 5,
                }, device.pluginData[PLUGIN_ID] ?? {});
                return reply.code(202).send({ scheduleId: schedule.id, message: 'Read-only Messages inspection scheduled' });
            });
            context.app.post<{
                Body: { recipientsText?: string; body?: string; intervalSeconds?: number; mediaSha256?: string };
            }>(`${context.routePrefix}/batch-preview`, async (request, reply) => {
                try {
                    const devices = (await context.loadDevices()).map((device) => ({
                        udid: device.udid, name: device.name, enabled: !device.disabled,
                    }));
                    return createBatchPreview({
                        recipientsText: request.body.recipientsText ?? '', body: request.body.body ?? '', devices,
                        ...(request.body.intervalSeconds !== undefined ? { intervalSeconds: request.body.intervalSeconds } : {}),
                        ...(request.body.mediaSha256 ? { mediaSha256: request.body.mediaSha256 } : {}),
                    });
                } catch (error) {
                    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
                }
            });
        },
    };
}

export { PLUGIN_ID as messagesAgentPluginId };
