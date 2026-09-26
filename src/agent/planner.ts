/**
 * Optional, OpenAI-compatible vision planner.
 *
 * Privacy default: this is OFF unless both AGENT_PLANNER_URL and
 * AGENT_ALLOW_SCREEN_UPLOAD=true are configured. A phone screenshot can
 * contain private conversations, so no screenshot is ever sent by default.
 */
export type DeviceReadiness = 'ready' | 'locked' | 'offline' | 'needs-human' | 'unknown';

export interface AgentAssessment {
    readiness: DeviceReadiness;
    /** A short opaque operator note. It must not quote screen or message text. */
    note: string;
}

export interface ScreenPlanner {
    assessMessagesScreen(screenshot: Buffer): Promise<AgentAssessment>;
}

const READINESS = new Set<DeviceReadiness>(['ready', 'locked', 'offline', 'needs-human', 'unknown']);

function endpoint(): string | undefined {
    const value = process.env.AGENT_PLANNER_URL?.trim();
    if (!value || process.env.AGENT_ALLOW_SCREEN_UPLOAD !== 'true') return;
    return value.replace(/\/$/, '');
}

function validateAssessment(value: unknown): AgentAssessment {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Agent response must be a JSON object');
    const candidate = value as { readiness?: unknown; note?: unknown };
    if (typeof candidate.readiness !== 'string' || !READINESS.has(candidate.readiness as DeviceReadiness)) {
        throw new Error('Agent response has an invalid readiness value');
    }
    if (typeof candidate.note !== 'string' || candidate.note.length > 280 || /[\r\n]/.test(candidate.note)) {
        throw new Error('Agent response has an invalid note');
    }
    return { readiness: candidate.readiness as DeviceReadiness, note: candidate.note };
}

class OpenAICompatibleScreenPlanner implements ScreenPlanner {
    constructor(private readonly baseUrl: string, private readonly model: string, private readonly apiKey?: string) {}

    async assessMessagesScreen(screenshot: Buffer): Promise<AgentAssessment> {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
            },
            body: JSON.stringify({
                model: this.model,
                temperature: 0,
                response_format: { type: 'json_object' },
                messages: [
                    {
                        role: 'system',
                        content: 'You are a read-only iPhone Messages screen checker. Return JSON only: {"readiness":"ready|locked|offline|needs-human|unknown","note":"short generic status"}. Never quote, transcribe, summarize, infer, or reveal any conversation, phone number, contact, message body, image, or notification. Never suggest typing, attaching, or sending. If unsure, use needs-human.',
                    },
                    {
                        role: 'user',
                        content: [{ type: 'text', text: 'Classify whether this iPhone is in a usable state for a human-approved dispatcher.' }, {
                            type: 'image_url', image_url: { url: `data:image/png;base64,${screenshot.toString('base64')}` },
                        }],
                    },
                ],
            }),
            signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`Agent planner returned HTTP ${response.status}`);
        const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new Error('Agent planner returned no JSON content');
        let parsed: unknown;
        try { parsed = JSON.parse(content); } catch { throw new Error('Agent planner returned malformed JSON'); }
        return validateAssessment(parsed);
    }
}

/** Returns undefined unless screenshot upload was explicitly enabled. */
export function configuredScreenPlanner(): ScreenPlanner | undefined {
    const baseUrl = endpoint();
    if (!baseUrl) return;
    const model = process.env.AGENT_PLANNER_MODEL?.trim() || 'gpt-4.1-mini';
    return new OpenAICompatibleScreenPlanner(baseUrl, model, process.env.AGENT_PLANNER_API_KEY);
}

export { validateAssessment };
