import { digestForAudit, assertE164 } from '../agent/safety.js';

export interface MessageDevice {
    udid: string;
    name: string;
    enabled: boolean;
}

export interface BatchPreviewInput {
    recipientsText: string;
    body: string;
    devices: readonly MessageDevice[];
    mediaSha256?: string;
    intervalSeconds?: number;
}

export interface BatchRecipient {
    recipient: string;
    deviceUdid: string;
    deviceName: string;
    sequenceOnDevice: number;
    dispatchAfterSeconds: number;
}

export interface BatchPreview {
    recipientCount: number;
    duplicateCount: number;
    bodySha256: string;
    bodySummary: string;
    mediaSha256?: string;
    intervalSeconds: number;
    perDevice: Array<{ udid: string; name: string; count: number }>;
    recipients: BatchRecipient[];
}

const SHA256 = /^[a-f0-9]{64}$/;

function summary(body: string): string {
    const compact = body.replace(/\s+/g, ' ').trim();
    const chars = [...compact];
    return chars.length <= 80 ? compact : `${chars.slice(0, 80).join('')}…`;
}

/**
 * Parse one international phone number per line. Empty lines are ignored;
 * duplicate numbers are retained only once, in their first-seen order.
 */
export function parseRecipients(recipientsText: string): { recipients: string[]; duplicateCount: number } {
    if (typeof recipientsText !== 'string') throw new Error('recipientsText must be a string');
    const recipients: string[] = [];
    const seen = new Set<string>();
    let duplicateCount = 0;
    for (const raw of recipientsText.split(/\r?\n/)) {
        const recipient = raw.trim();
        if (!recipient) continue;
        assertE164(recipient);
        if (seen.has(recipient)) { duplicateCount += 1; continue; }
        seen.add(recipient);
        recipients.push(recipient);
    }
    if (!recipients.length) throw new Error('Enter at least one international recipient number');
    return { recipients, duplicateCount };
}

/**
 * Deterministic A/B/A/B distribution. Each phone starts at the same time, but
 * its own next recipient is delayed by intervalSeconds. That means two devices
 * run in parallel without either device sending too quickly.
 */
export function createBatchPreview(input: BatchPreviewInput): BatchPreview {
    if (typeof input.body !== 'string' || !input.body.trim()) throw new Error('Message body is required');
    const intervalSeconds = input.intervalSeconds ?? 10;
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 3600) {
        throw new Error('intervalSeconds must be a whole number between 1 and 3600');
    }
    if (input.mediaSha256 !== undefined && !SHA256.test(input.mediaSha256)) {
        throw new Error('mediaSha256 must be a lowercase SHA-256 digest');
    }
    const devices = input.devices.filter((device) => device.enabled);
    if (!devices.length) throw new Error('At least one enabled iPhone is required');
    const uniqueUdids = new Set(devices.map((device) => device.udid));
    if (uniqueUdids.size !== devices.length) throw new Error('Every enabled iPhone must have a unique UDID');
    if (devices.some((device) => !device.udid || !device.name)) throw new Error('Every enabled iPhone needs a name and UDID');

    const { recipients, duplicateCount } = parseRecipients(input.recipientsText);
    const counts = new Map(devices.map((device) => [device.udid, 0]));
    const assignments = recipients.map((recipient, index) => {
        const device = devices[index % devices.length]!;
        const sequenceOnDevice = counts.get(device.udid)!;
        counts.set(device.udid, sequenceOnDevice + 1);
        return {
            recipient, deviceUdid: device.udid, deviceName: device.name, sequenceOnDevice,
            dispatchAfterSeconds: sequenceOnDevice * intervalSeconds,
        };
    });
    return {
        recipientCount: recipients.length, duplicateCount, bodySha256: digestForAudit(input.body), bodySummary: summary(input.body),
        ...(input.mediaSha256 ? { mediaSha256: input.mediaSha256 } : {}), intervalSeconds,
        perDevice: devices.map((device) => ({ udid: device.udid, name: device.name, count: counts.get(device.udid)! })),
        recipients: assignments,
    };
}
