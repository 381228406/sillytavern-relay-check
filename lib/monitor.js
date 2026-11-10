/**
 * Auto-monitor normal Chat Completion traffic going through ST's backend proxy.
 * Captures model / usage / id / latency from /generate without extra quota.
 * Does not store prompts or secrets.
 */
import { getConnectionSnapshot } from './connection.js';
import { PROBE_HEADER } from './probe.js';
import {
    VERDICT,
    analyzeIdPrefix,
    analyzeUsage,
    buildVerdict,
    compareModels,
    extractResponseMeta,
    getModelFamily,
    isLatencyAnomaly,
} from './analyze.js';
import { getSettings, pushHistory } from './store.js';

const GENERATE_PATH = '/api/backends/chat-completions/generate';
const LATENCY_WINDOW = 8;

let installed = false;
let originalFetch = null;
let listeners = [];
let recentLatencies = [];
let lastToastKey = '';
let lastToastAt = 0;

export function startMonitor(onUpdate) {
    if (typeof onUpdate === 'function') {
        listeners.push(onUpdate);
    }
    installFetchHook();
    bindGenerationEvents();
}

export function stopMonitor() {
    listeners = [];
    // Keep the hook installed so toggling auto-monitor mid-session is cheap;
    // handleMonitorResponse already checks the setting.
}

function notify(result) {
    for (const listener of listeners) {
        try {
            listener(result);
        } catch (error) {
            console.warn('[中转检测] monitor listener failed:', error);
        }
    }
}

function installFetchHook() {
    if (installed || typeof window.fetch !== 'function') {
        return;
    }
    originalFetch = window.fetch.bind(window);
    window.fetch = async function relayCheckPatchedFetch(input, init) {
        const url = getUrl(input);
        if (!isGenerateUrl(url) || isOurProbe(input, init)) {
            return originalFetch(input, init);
        }
        const requestModel = readRequestModel(input, init);
        const requestType = readRequestType(input, init);
        const started = performance.now();
        const response = await originalFetch(input, init);
        try {
            // Quiet / impersonate-like traffic is ignored to avoid flagging extension summaries.
            if (requestType && requestType !== 'normal' && requestType !== 'continue' && requestType !== 'swipe' && requestType !== 'regenerate' && requestType !== 'impersonate') {
                if (requestType === 'quiet') {
                    return response;
                }
            }
            observeResponse(response.clone(), {
                requestModel,
                requestType,
                started,
                httpStatus: response.status,
                ok: response.ok,
                stream: isLikelyStream(response, init),
            }).catch((error) => console.warn('[中转检测] 观察生成响应失败:', error));
        } catch (error) {
            console.warn('[中转检测] 无法克隆生成响应:', error);
        }
        return response;
    };
    installed = true;
}

function getUrl(input) {
    if (typeof input === 'string') {
        return input;
    }
    if (input && typeof input === 'object' && 'url' in input) {
        return String(input.url || '');
    }
    return '';
}

function isGenerateUrl(url) {
    return typeof url === 'string' && url.includes(GENERATE_PATH);
}

function isOurProbe(input, init) {
    try {
        const headers = new Headers(init?.headers || (input && input.headers) || undefined);
        return headers.get(PROBE_HEADER) === '1';
    } catch {
        return false;
    }
}

function readRequestModel(input, init) {
    try {
        const raw = init?.body;
        if (typeof raw === 'string') {
            const parsed = JSON.parse(raw);
            return String(parsed?.model || '');
        }
    } catch {
        // body may not be JSON
    }
    return getConnectionSnapshot().model || '';
}

function readRequestType(input, init) {
    try {
        const raw = init?.body;
        if (typeof raw === 'string') {
            const parsed = JSON.parse(raw);
            return String(parsed?.type || '');
        }
    } catch {
        // ignore
    }
    return '';
}

function isLikelyStream(response, init) {
    const contentType = response.headers?.get?.('content-type') || '';
    if (/text\/event-stream|ndjson/i.test(contentType)) {
        return true;
    }
    try {
        if (typeof init?.body === 'string') {
            const parsed = JSON.parse(init.body);
            return !!parsed.stream;
        }
    } catch {
        // ignore
    }
    return false;
}

async function observeResponse(response, { requestModel, requestType, started, httpStatus, ok, stream }) {
    const settings = getSettings();
    if (!settings.autoMonitor) {
        return;
    }
    let data = null;
    try {
        if (stream) {
            const text = await response.text();
            data = parseMaybeSse(text);
        } else {
            data = await response.json();
        }
    } catch {
        data = null;
    }
    const latencyMs = Math.round(performance.now() - started);
    const meta = extractResponseMeta(data);
    const snapshot = getConnectionSnapshot();
    const requested = requestModel || snapshot.model;
    const modelCompare = compareModels(requested, meta.model);
    const usageAnalysis = analyzeUsage(meta.usage, null, meta.text);
    const idAnalysis = analyzeIdPrefix(meta.id, getModelFamily(meta.model || requested), snapshot.source);

    let health = { ok: true, summary: `自动监控到一次${stream ? '流式' : '非流式'}生成，延迟 ${latencyMs} ms。` };
    if (!ok || (data && data.error && !meta.text)) {
        health = { ok: false, summary: `自动监控：生成请求异常（HTTP ${httpStatus}）${data?.error ? `：${data.error?.message || data.error}` : ''}。` };
    }

    const baseline = median(recentLatencies);
    const latencyAnalysis = {
        suspicious: isLatencyAnomaly(latencyMs, baseline),
        note: isLatencyAnomaly(latencyMs, baseline)
            ? `本次延迟 ${latencyMs} ms，明显高于近期中位值 ${Math.round(baseline)} ms。`
            : `本次延迟 ${latencyMs} ms。`,
    };
    if (ok && Number.isFinite(latencyMs)) {
        recentLatencies.push(latencyMs);
        if (recentLatencies.length > LATENCY_WINDOW) {
            recentLatencies.shift();
        }
    }

    const built = buildVerdict({ health, modelCompare, usageAnalysis, idAnalysis, latencyAnalysis });
    const result = {
        time: Date.now(),
        mode: 'auto',
        verdict: built.verdict,
        label: built.label,
        summary: built.summary,
        disclaimer: '自动监控只观察酒馆已经发出的生成请求，不会额外消耗探测额度。这是辅助判断，不能 100% 证明官方真模型。',
        connection: {
            mainApi: snapshot.mainApi,
            source: snapshot.source,
            sourceLabel: snapshot.sourceLabel,
            model: requested,
            customUrl: snapshot.customUrl,
            streamEnabled: snapshot.streamEnabled,
            onlineStatus: snapshot.onlineStatus,
        },
        health,
        checks: {
            model: modelCompare,
            usage: usageAnalysis,
            id: idAnalysis,
            latency: latencyAnalysis,
            generate: { ok, latencyMs, httpStatus, method: 'monitor', error: health.ok ? '' : health.summary },
        },
        metrics: {
            requestedModel: requested,
            responseModel: meta.model || '',
            responseId: meta.id || '',
            latencyMs,
            usage: meta.usage,
            requestType: requestType || 'unknown',
            headers: '无法获取（酒馆后端代理不会把上游 HTTP 头原样传回前端）',
        },
        items: [],
    };
    result.items = [
        { title: '自动监控', detail: `${health.summary} 类型：${requestType || '无法获取'}。` },
        { title: '路由 / 模型比对', detail: `请求：${requested || '无法获取'}\n回包：${meta.model || '无法获取'}\n${modelCompare.note}` },
        { title: 'usage 用量', detail: usageAnalysis.note },
        { title: '响应 id 前缀', detail: idAnalysis.note },
        { title: '延迟', detail: latencyAnalysis.note },
        { title: '说明', detail: result.disclaimer },
    ];

    pushHistory(result);
    notify(result);
    maybeToast(result, settings);
}

function parseMaybeSse(text) {
    const raw = String(text || '');
    if (raw.trim().startsWith('{')) {
        try {
            return JSON.parse(raw);
        } catch {
            // fall through to SSE parse
        }
    }
    const chunks = [];
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
            chunks.push(JSON.parse(payload));
        } catch {
            // skip
        }
    }
    if (!chunks.length) {
        return null;
    }
    const last = chunks[chunks.length - 1] || {};
    const first = chunks[0] || {};
    const lastWithUsage = [...chunks].reverse().find((c) => c?.usage || c?.usageMetadata) || {};
    let content = '';
    for (const chunk of chunks) {
        const piece = chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content ?? '';
        if (typeof piece === 'string') content += piece;
    }
    return {
        id: last.id || first.id || '',
        model: last.model || first.model || lastWithUsage.model || '',
        object: last.object || first.object || '',
        usage: lastWithUsage.usage || last.usage,
        usageMetadata: lastWithUsage.usageMetadata || last.usageMetadata,
        system_fingerprint: last.system_fingerprint || first.system_fingerprint,
        choices: [{ message: { role: 'assistant', content }, finish_reason: last.choices?.[0]?.finish_reason }],
        candidates: last.candidates,
        content: last.content,
        stop_reason: last.stop_reason,
    };
}

function maybeToast(result, settings) {
    if (!settings.toastOnIssue) {
        return;
    }
    if (result.verdict === VERDICT.OK || result.verdict === VERDICT.UNKNOWN) {
        return;
    }
    const key = `${result.verdict}:${result.metrics?.responseModel || ''}:${result.metrics?.requestedModel || ''}`;
    const now = Date.now();
    if (key === lastToastKey && now - lastToastAt < 60_000) {
        return;
    }
    lastToastKey = key;
    lastToastAt = now;
    const message = result.summary || result.label;
    if (result.verdict === VERDICT.ERROR) {
        toastr.error(message, '中转检测', { timeOut: 6000, preventDuplicates: true });
    } else if (result.verdict === VERDICT.ROUTE) {
        toastr.warning(message, '中转检测', { timeOut: 6000, preventDuplicates: true });
    } else {
        toastr.info(message, '中转检测', { timeOut: 4000, preventDuplicates: true });
    }
}

function bindGenerationEvents() {
    const ctx = SillyTavern.getContext();
    const { eventSource, event_types } = ctx;
    if (!eventSource || !event_types?.GENERATION_ENDED) {
        return;
    }
    eventSource.on(event_types.GENERATION_ENDED, () => {
        // Fallback only: message.extra.model is the requested model (getGeneratingModel),
        // and token_count is a local tokenizer estimate — not upstream usage.
        // Real routing signals come from the fetch hook above.
        const settings = getSettings();
        if (!settings.autoMonitor) {
            return;
        }
        try {
            const chat = ctx.chat;
            const last = Array.isArray(chat) ? chat[chat.length - 1] : null;
            if (!last || last.is_user) {
                return;
            }
            const started = last.gen_started ? new Date(last.gen_started).getTime() : null;
            const finished = last.gen_finished ? new Date(last.gen_finished).getTime() : null;
            if (started && finished && finished >= started) {
                const latencyMs = finished - started;
                if (Number.isFinite(latencyMs)) {
                    recentLatencies.push(latencyMs);
                    if (recentLatencies.length > LATENCY_WINDOW) {
                        recentLatencies.shift();
                    }
                }
            }
        } catch (error) {
            console.warn('[中转检测] GENERATION_ENDED 回退处理失败:', error);
        }
    });
}

function median(values) {
    if (!values.length) {
        return NaN;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
