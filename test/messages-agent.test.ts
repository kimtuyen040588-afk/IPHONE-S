import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assertAgentCannotSend, assertE164, createObservePlan, digestForAudit, validateApprovedMessageIntent,
} from '../src/agent/safety.js';
import { createMessagesAgentPlugin, messagesAgentPluginId } from '../src/messages-agent-plugin.js';
import { PluginRegistry } from '../src/registry.js';

test('agent observe plan has only read-only device actions', () => {
    const plan = createObservePlan('00008110-device', 'check-001');
    assert.deepEqual(plan.actions, ['launch-messages', 'capture-screen']);
    assert.throws(() => assertAgentCannotSend('tap-send'), /not allowed/);
});

test('message intent requires a confirmed immutable digest and E.164 recipient', () => {
    assert.doesNotThrow(() => assertE164('+8613812345678'));
    assert.throws(() => assertE164('13812345678'), /E.164/);
    const digest = digestForAudit('private message body');
    assert.equal(digest.length, 64);
    assert.equal(validateApprovedMessageIntent({
        batchId: 'batch-001', confirmationId: 'approved-001', recipient: '+8613812345678', bodySha256: digest,
    }).bodySha256, digest);
    assert.throws(() => validateApprovedMessageIntent({
        batchId: 'batch-001', confirmationId: 'approved-001', recipient: '+8613812345678', bodySha256: 'wrong',
    }), /SHA-256/);
});

test('messages agent registers a read-only inspection task', () => {
    const plugin = createMessagesAgentPlugin();
    const registry = new PluginRegistry([plugin]);
    const valid = registry.validate({
        deviceUdid: 'device-12345678',
        task: { pluginId: messagesAgentPluginId, taskType: 'inspect-messages', taskVersion: 1, payload: { requestId: 'check-001' } },
        timing: { kind: 'now' },
    });
    assert.equal(registry.task(valid.task).summarize(valid.task.payload), 'Agent inspection · Messages · no message sent');
    assert.throws(() => registry.validate({
        deviceUdid: 'device-12345678',
        task: { pluginId: messagesAgentPluginId, taskType: 'inspect-messages', taskVersion: 1, payload: { requestId: 'bad space' } },
        timing: { kind: 'now' },
    }), /requestId/);
});
