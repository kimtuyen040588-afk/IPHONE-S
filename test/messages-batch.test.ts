import assert from 'node:assert/strict';
import test from 'node:test';

import { createBatchPreview, parseRecipients } from '../src/messages/batch.js';

const devices = [
    { udid: 'A', name: 'iPhone A', enabled: true },
    { udid: 'B', name: 'iPhone B', enabled: true },
];

test('batch preview removes blanks and duplicates then uses A/B round robin', () => {
    const preview = createBatchPreview({
        recipientsText: '+8613812345678\n\n+8613912345678\n+8613812345678\n+8613012345678',
        body: '您好，这是一条测试消息。', devices,
    });
    assert.equal(preview.recipientCount, 3);
    assert.equal(preview.duplicateCount, 1);
    assert.deepEqual(preview.recipients.map((item) => [item.recipient, item.deviceUdid, item.dispatchAfterSeconds]), [
        ['+8613812345678', 'A', 0], ['+8613912345678', 'B', 0], ['+8613012345678', 'A', 10],
    ]);
    assert.deepEqual(preview.perDevice.map((item) => item.count), [2, 1]);
    assert.equal(preview.bodySha256.length, 64);
    assert.equal(preview.bodySummary, '您好，这是一条测试消息。');
});

test('batch preview rejects a bad number and does not silently repair it', () => {
    assert.throws(() => parseRecipients('+8613812345678\n13812345678'), /E.164/);
});

test('batch preview uses only enabled devices and supports a single phone', () => {
    const preview = createBatchPreview({
        recipientsText: '+8613812345678\n+8613912345678', body: 'test',
        devices: [{ udid: 'A', name: 'iPhone A', enabled: true }, { udid: 'B', name: 'iPhone B', enabled: false }],
        intervalSeconds: 12,
    });
    assert.deepEqual(preview.recipients.map((item) => [item.deviceUdid, item.dispatchAfterSeconds]), [['A', 0], ['A', 12]]);
});
