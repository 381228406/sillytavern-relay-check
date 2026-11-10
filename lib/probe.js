/**
 * Talk to SillyTavern's own Chat Completions backend proxy.
 * Never send keys or prompts to a third party.
 */
import { getConnectionSnapshot, getStatusPayload, getGeneratePayload } from './connection.js';
import { extractResponseMeta } from './analyze.js';

export const PROBE_HEADER = 'X-Relay-Check-Probe';

const QUICK_TIMEOUT_MS = 30000;
const DEEP_TIMEOUT_MS = 60000;
const QUICK_MAX_TOKENS = 16;

function getHeaders() {
    const ctx = SillyTavern.getContext();
    const headers = ctx.getRequestHeaders ? ctx.getRequestHeaders() : { 'Content-Type': 'application/json' };
    return { ...headers, [PROBE_HEADER]: '1' };
}

function withTimeout(ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
    return { controller, cancel: () => clearTimeout(timer) };
}

export async function probeStatus(snapshot = getConnectionSnapshot()) {
    const started = performance.now();
    const { controller, cancel } = withTimeout(QUICK_TIMEOUT_MS);
    try {
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify(getStatusPayload(snapshot)),
            cache: 'no-cache',
            signal: controller.signal,
        });
        const latencyMs = Math.round(performance.now() - started);
        let body = null;
        try {
            body = await response.json();
        } catch {
            body = null;
        }
        const models = extractModelList(body);
        const authFailed = response.status === 401 || response.status === 403
            || (body && body.error && /key|token|unauthor|forbidden|invalid/i.test(JSON.stringify(body.message || body.error || '')));
        const ok = (response.ok && !(body && body.error && !body.bypass)) || models.length > 0 || !!body?.bypass;
        return {
            ok,
            httpStatus: response.status,
            latencyMs,
            error: body?.error ? (body.message || 'status 返回了 error') : (response.ok ? '' : `HTTP ${response.status}`),
            bypass: !!(body && body.bypass),
            models,
            modelIds: models.map((m) => m.id).filter(Boolean),
            currentModelInList: isModelInList(snapshot.model, models),
            authFailed,
            bodyError: !!(body && body.error),
        };
    } catch (error) {
        const latencyMs = Math.round(performance.now() - started);
        const timeout = isTimeout(error);
        return {
            ok: false,
            httpStatus: 0,
            latencyMs,
            error: timeout ? `状态检查超时（>${QUICK_TIMEOUT_MS} ms）` : (error?.message || String(error)),
            bypass: false,
            models: [],
            modelIds: [],
            currentModelInList: null,
            authFailed: false,
            bodyError: true,
            timeout,
        };
    } finally {
        cancel();
    }
}

function extractModelList(body) {
    if (!body || typeof body !== 'object') {
        return [];
    }
    let list = [];
    if (Array.isArray(body.data)) {
        list = body.data;
    } else if (Array.isArray(body.data?.data)) {
        list = body.data.data;
    } else if (Array.isArray(body.models)) {
        list = body.models;
    }
    return list
        .map((item) => {
            if (!item) return null;
            if (typeof item === 'string') return { id: item };
            const id = item.id || item.name || item.model || '';
            return id ? { id: String(id), name: item.name || item.display_name || '' } : null;
        })
        .filter(Boolean);
}

function isModelInList(model, models) {
    if (!model) {
        return null;
    }
    const needle = String(model).trim().toLowerCase();
    if (!models.length) {
        return null;
    }
    return models.some((item) => String(item.id || '').toLowerCase() === needle);
}

export async function probeGenerate({
    snapshot = getConnectionSnapshot(),
    prompt = 'Reply with the single word OK.',
    systemPrompt = 'You are a concise assistant. Follow the user instruction exactly.',
    maxTokens = QUICK_MAX_TOKENS,
    stream = false,
    timeoutMs = QUICK_TIMEOUT_MS,
    preferContext = true,
} = {}) {
    // generateRawData always uses type=quiet, which forces non-stream in sendOpenAIRequest.
    if (preferContext && !stream) {
        const viaContext = await tryGenerateRawData({ systemPrompt, prompt, maxTokens, timeoutMs });
        if (viaContext) {
            return viaContext;
        }
    }
    return generateViaProxy({ snapshot, prompt, systemPrompt, maxTokens, stream, timeoutMs });
}

async function tryGenerateRawData({ systemPrompt, prompt, maxTokens, timeoutMs }) {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.generateRawData !== 'function') {
        return null;
    }
    const started = performance.now();
    const { controller, cancel } = withTimeout(timeoutMs);
    const abortHook = () => controller.abort(new Error('cancelled'));
    // We don't get a hook into generateRawData's internal abort, but we can still time out
    // by racing.
    try {
        const data = await Promise.race([
            ctx.generateRawData({
                systemPrompt,
                prompt,
                responseLength: maxTokens,
            }),
            new Promise((_, reject) => {
                controller.signal.addEventListener('abort', () => reject(controller.signal.reason || new Error('timeout')));
            }),
        ]);
        const latencyMs = Math.round(performance.now() - started);
        const meta = extractResponseMeta(data);
        return {
            ok: true,
            httpStatus: 200,
            latencyMs,
            ttfbMs: latencyMs,
            stream: false,
            method: 'generateRawData',
            data,
            meta,
            error: '',
            timeout: false,
        };
    } catch (error) {
        // If generateRawData is present but throws a structural error (not API),
        // fall through to the proxy path by returning null only for "function missing"-like cases.
        const message = error?.message || String(error);
        if (/is not a function|undefined/i.test(message)) {
            return null;
        }
        if (isTimeout(error) && typeof ctx.stopGeneration === 'function') {
            try { ctx.stopGeneration(); } catch { /* ignore */ }
        }
        const latencyMs = Math.round(performance.now() - started);
        return {
            ok: false,
            httpStatus: 0,
            latencyMs,
            ttfbMs: null,
            stream: false,
            method: 'generateRawData',
            data: null,
            meta: extractResponseMeta(null),
            error: isTimeout(error) ? `生成超时（>${timeoutMs} ms）` : message,
            timeout: isTimeout(error),
        };
    } finally {
        cancel();
        try { abortHook(); } catch { /* noop */ }
    }
}

async function generateViaProxy({ snapshot, prompt, systemPrompt, maxTokens, stream, timeoutMs }) {
    const messages = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });
    const body = getGeneratePayload(snapshot, { messages, maxTokens, stream, temperature: 0 });
    const started = performance.now();
    const { controller, cancel } = withTimeout(timeoutMs);
    try {
        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify(body),
            cache: 'no-cache',
            signal: controller.signal,
        });
        const ttfbMs = Math.round(performance.now() - started);

        if (!response.ok) {
            let detail = `HTTP ${response.status}`;
            let text = '';
            try {
                text = await response.text();
                const parsed = JSON.parse(text);
                detail = parsed?.error?.message || parsed?.message || parsed?.error || detail;
                if (typeof detail === 'object') {
                    detail = JSON.stringify(detail);
                }
            } catch {
                if (text) {
                    detail = `${detail}: ${text.slice(0, 200)}`;
                }
            }
            return {
                ok: false,
                httpStatus: response.status,
                latencyMs: Math.round(performance.now() - started),
                ttfbMs,
                stream: !!stream,
                method: 'proxy',
                data: null,
                meta: extractResponseMeta(null),
                error: String(detail),
                timeout: false,
                rateLimited: response.status === 429,
                authFailed: response.status === 401 || response.status === 403,
            };
        }

        if (stream) {
            const parsed = await readSseResponse(response, started);
            const latencyMs = Math.round(performance.now() - started);
            return {
                ok: true,
                httpStatus: response.status,
                latencyMs,
                ttfbMs: parsed.ttfbMs ?? ttfbMs,
                stream: true,
                method: 'proxy',
                data: parsed.data,
                meta: extractResponseMeta(parsed.data),
                error: '',
                timeout: false,
            };
        }

        const data = await response.json();
        const latencyMs = Math.round(performance.now() - started);
        if (data?.error) {
            const message = data.error?.message || data.message || 'API 返回了 error';
            return {
                ok: false,
                httpStatus: response.status,
                latencyMs,
                ttfbMs,
                stream: false,
                method: 'proxy',
                data,
                meta: extractResponseMeta(data),
                error: typeof message === 'string' ? message : JSON.stringify(message),
                timeout: false,
            };
        }
        return {
            ok: true,
            httpStatus: response.status,
            latencyMs,
            ttfbMs,
            stream: false,
            method: 'proxy',
            data,
            meta: extractResponseMeta(data),
            error: '',
            timeout: false,
        };
    } catch (error) {
        const latencyMs = Math.round(performance.now() - started);
        return {
            ok: false,
            httpStatus: 0,
            latencyMs,
            ttfbMs: null,
            stream: !!stream,
            method: 'proxy',
            data: null,
            meta: extractResponseMeta(null),
            error: isTimeout(error) ? `生成超时（>${timeoutMs} ms）` : (error?.message || String(error)),
            timeout: isTimeout(error),
        };
    } finally {
        cancel();
    }
}

async function readSseResponse(response, started) {
    const reader = response.body?.getReader();
    if (!reader) {
        const text = await response.text();
        return parseSseText(text, started);
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let ttfbMs = null;
    const chunks = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (ttfbMs == null) {
            ttfbMs = Math.round(performance.now() - started);
        }
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';
        for (const line of parts) {
            const data = parseSseLine(line);
            if (data) {
                chunks.push(data);
            }
        }
    }
    if (buffer) {
        const data = parseSseLine(buffer);
        if (data) {
            chunks.push(data);
        }
    }
    return { data: mergeSseChunks(chunks), ttfbMs };
}

function parseSseText(text, started) {
    const chunks = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        const data = parseSseLine(line);
        if (data) {
            chunks.push(data);
        }
    }
    return { data: mergeSseChunks(chunks), ttfbMs: Math.round(performance.now() - started) };
}

function parseSseLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed.startsWith('data:')) {
        return null;
    }
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') {
        return null;
    }
    try {
        return JSON.parse(payload);
    } catch {
        return null;
    }
}

function mergeSseChunks(chunks) {
    if (!chunks.length) {
        return {};
    }
    const lastWithUsage = [...chunks].reverse().find((c) => c?.usage || c?.usageMetadata);
    const first = chunks[0] || {};
    const last = chunks[chunks.length - 1] || {};
    let text = '';
    for (const chunk of chunks) {
        const piece =
            chunk?.choices?.[0]?.delta?.content
            ?? chunk?.choices?.[0]?.message?.content
            ?? chunk?.delta?.text
            ?? '';
        if (typeof piece === 'string') {
            text += piece;
        }
    }
    return {
        id: last.id || first.id || '',
        object: last.object || first.object || '',
        model: last.model || first.model || lastWithUsage?.model || '',
        choices: [{
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: last.choices?.[0]?.finish_reason || last.stop_reason || null,
            delta: last.choices?.[0]?.delta,
        }],
        usage: lastWithUsage?.usage || last.usage || first.usage,
        usageMetadata: lastWithUsage?.usageMetadata || last.usageMetadata,
        system_fingerprint: last.system_fingerprint || first.system_fingerprint,
        content: last.content,
        stop_reason: last.stop_reason,
        candidates: last.candidates || first.candidates,
    };
}

function isTimeout(error) {
    if (!error) {
        return false;
    }
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        return true;
    }
    const message = String(error.message || error);
    return /timeout|aborted|Timed out/i.test(message);
}

export async function estimateTokens(text) {
    const ctx = SillyTavern.getContext();
    const value = String(text || '');
    if (!value) {
        return 0;
    }
    try {
        if (typeof ctx.getTokenCountAsync === 'function') {
            const count = await ctx.getTokenCountAsync(value, 0);
            if (Number.isFinite(count)) {
                return count;
            }
        }
    } catch (error) {
        console.warn('[中转检测] token 估算失败，改用字符近似:', error);
    }
    return Math.max(1, Math.round(value.length / 4));
}

export function makeNonce(length = 8) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function buildNeedlePrompt(targetChars = 8000) {
    const code = makeNonce(10);
    const header = `The secret inspection code is ${code}. It appears only here, at the very beginning. After the filler text, reply with ONLY that exact code and nothing else.\n\n---\n`;
    const line = 'Filler paragraph for context length only. This text is not the secret code. Keep reading until the instruction at the end.\n';
    const parts = [header];
    while (parts.join('').length < targetChars) {
        parts.push(line);
    }
    parts.push('\n---\nNow reply with ONLY the secret inspection code from the very beginning of this message.');
    return { prompt: parts.join(''), code };
}

export { QUICK_TIMEOUT_MS, DEEP_TIMEOUT_MS, QUICK_MAX_TOKENS };
