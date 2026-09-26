import crypto from 'node:crypto';

/**
 * The agent is intentionally not a free-form device driver. It may observe a
 * device and suggest a next step, but it never receives authority to change a
 * recipient, message body, attachment, or press Send.
 *
 * This small module is the boundary used by the message plugin today. When a
 * deterministic sender is added later, it must consume a separately approved
 * immutable message intent rather than an agent-generated string.
 */
export type AgentAction = 'launch-messages' | 'capture-screen';

export interface ObservePlan {
    kind: 'observe';
    requestId: string;
    deviceUdid: string;
    actions: readonly AgentAction[];
}

export interface ApprovedMessageIntent {
    batchId: string;
    recipient: string;
    bodySha256: string;
    mediaSha256?: string;
    confirmationId: string;
}

const E164 = /^\+[1-9]\d{1,14}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Validate an international number without storing it in agent observation logs. */
export function assertE164(recipient: string): void {
    if (!E164.test(recipient)) throw new Error('recipient must use international E.164 format, for example +8613812345678');
}

/** Only a human-confirmed batch can create a message intent. */
export function validateApprovedMessageIntent(value: ApprovedMessageIntent): ApprovedMessageIntent {
    if (!ID.test(value.batchId)) throw new Error('batchId must be 1–128 safe characters');
    if (!ID.test(value.confirmationId)) throw new Error('confirmationId must be 1–128 safe characters');
    assertE164(value.recipient);
    if (!SHA256.test(value.bodySha256)) throw new Error('bodySha256 must be a lowercase SHA-256 digest');
    if (value.mediaSha256 !== undefined && !SHA256.test(value.mediaSha256)) {
        throw new Error('mediaSha256 must be a lowercase SHA-256 digest');
    }
    return { ...value };
}

/** The only plan an LLM may execute in the first release. */
export function createObservePlan(deviceUdid: string, requestId: string): ObservePlan {
    if (!deviceUdid || deviceUdid.length > 128) throw new Error('deviceUdid is required');
    if (!ID.test(requestId)) throw new Error('requestId must be 1–128 safe characters');
    return { kind: 'observe', requestId, deviceUdid, actions: ['launch-messages', 'capture-screen'] };
}

/**
 * A stable digest is safe to put in logs. Never log the message body itself.
 */
export function digestForAudit(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Makes the boundary hard to miss if a future change tries to hand a send
 * button to an agent. The deterministic sender will get its own executor.
 */
export function assertAgentCannotSend(action: string): never {
    throw new Error(`Agent action "${action}" is not allowed. Agents may observe only; sending requires the deterministic, human-confirmed dispatcher.`);
}
