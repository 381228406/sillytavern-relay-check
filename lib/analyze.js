/**
 * Routing / protocol / health analysis. Pure functions, no network, no secrets.
 */

export const VERDICT = Object.freeze({
    OK: 'ok',
    SERIES: 'series',
    ROUTE: 'route',
    ERROR: 'error',
    UNKNOWN: 'unknown',
});

export const VERDICT_LABELS = Object.freeze({
    ok: '正常',
    series: '同系列分流',
    route: '疑似路由或换模型',
    error: '接口异常',
    unknown: '尚未检测',
});

const FAMILIES = [
    { id: 'claude', keys: ['claude', 'anthropic', 'sonnet', 'opus', 'haiku', 'fable'] },
    { id: 'gpt', keys: ['gpt-', 'gpt4', 'gpt5', 'gpt3', 'chatgpt', 'o1', 'o3', 'o4', 'davinci', 'text-davinci'] },
    { id: 'gemini', keys: ['gemini', 'gemma', 'makersuite'] },
    { id: 'llama', keys: ['llama', 'meta-llama', 'llava'] },
    { id: 'mistral', keys: ['mistral', 'mixtral', 'magistral', 'pixtral', 'codestral'] },
    { id: 'deepseek', keys: ['deepseek'] },
    { id: 'qwen', keys: ['qwen', 'qwq', 'qwen2', 'qwen3'] },
    { id: 'kimi', keys: ['kimi', 'moonshot'] },
    { id: 'grok', keys: ['grok', 'xai'] },
    { id: 'command', keys: ['command-r', 'command-a', 'cohere'] },
    { id: 'glm', keys: ['glm-', 'chatglm', 'zhipu', 'zai-'] },
    { id: 'yi', keys: ['yi-', '01-ai'] },
    { id: 'doubao', keys: ['doubao', 'seed-'] },
    { id: 'ernie', keys: ['ernie', 'wenxin'] },
    { id: 'hunyuan', keys: ['hunyuan'] },
    { id: 'step', keys: ['step-'] },
    { id: 'minimax', keys: ['minimax', 'abab'] },
    { id: 'nova', keys: ['amazon-nova', 'nova-'] },
    { id: 'phi', keys: ['phi-'] },
    { id: 'gemma', keys: ['gemma'] },
    { id: 'vicuna', keys: ['vicuna'] },
    { id: 'internlm', keys: ['internlm'] },
    { id: 'baichuan', keys: ['baichuan'] },
];

const VENDOR_PREFIXES = [
    'openai/', 'anthropic/', 'google/', 'google-gla/', 'google-vertex/', 'meta-llama/',
    'meta/', 'mistralai/', 'mistral/', 'deepseek/', 'qwen/', 'alibaba/', 'x-ai/', 'xai/',
    'cohere/', 'moonshotai/', 'moonshot/', 'z-ai/', 'zhipu/', 'amazon/', 'microsoft/',
    'nvidia/', 'perplexity/', 'groq/', 'fireworks/', 'together/', 'deepinfra/',
    'openrouter/', 'ai21/',
];

const SERIES_SUFFIXES = [
    /-20\d{6}(-\d+)?$/i,
    /-\d{8}$/i,
    /:(free|nitro|floor|exacto|extended|online)$/i,
    /-(latest|preview|exp|experimental|beta|alpha|thinking|reasoning|instruct|chat|it)$/i,
    /-(high|low|medium|fast|lite|mini|nano|micro|pro|max|plus|flash|ultra|small|large|tiny)$/i,
];

/**
 * @param {string} name
 * @returns {string}
 */
export function normalizeModelName(name) {
    if (!name || typeof name !== 'string') {
        return '';
    }
    let value = name.trim().toLowerCase().replace(/_/g, '-');
    for (const prefix of VENDOR_PREFIXES) {
        if (value.startsWith(prefix)) {
            value = value.slice(prefix.length);
        }
    }
    // OpenRouter-style vendor still left: "google/gemini-..." after only first strip
    const slash = value.indexOf('/');
    if (slash > 0 && slash < value.length - 1) {
        value = value.slice(slash + 1);
    }
    return value;
}

export function getModelFamily(name) {
    const normalized = normalizeModelName(name);
    if (!normalized) {
        return '';
    }
    // Longer / more specific keys first is handled by the order in FAMILIES
    // plus scanning all and picking the first match on the normalized string.
    for (const family of FAMILIES) {
        for (const key of family.keys) {
            if (normalized.includes(key) || name.toLowerCase().includes(key)) {
                return family.id;
            }
        }
    }
    // Use the first hyphen-delimited token as a weak family.
    return normalized.split('-')[0] || '';
}

function stripSeriesDecorators(name) {
    let value = normalizeModelName(name);
    let changed = true;
    while (changed) {
        changed = false;
        const before = value;
        for (const pattern of SERIES_SUFFIXES) {
            value = value.replace(pattern, '');
        }
        // trailing date already handled; also drop leftover ":suffix"
        value = value.replace(/:[a-z0-9-]+$/i, '');
        if (value !== before) {
            changed = true;
        }
    }
    return value;
}

/**
 * Compare requested vs response model names.
 * @returns {{ kind: 'match'|'series'|'swap'|'unknown', requested: string, returned: string, familyRequested: string, familyReturned: string, note: string }}
 */
export function compareModels(requested, returned) {
    const req = String(requested || '').trim();
    const res = String(returned || '').trim();
    if (!res) {
        return {
            kind: 'unknown',
            requested: req,
            returned: res,
            familyRequested: getModelFamily(req),
            familyReturned: '',
            note: '回包未提供 model 字段，无法比对，记为「无法获取」。',
        };
    }
    const normReq = normalizeModelName(req);
    const normRes = normalizeModelName(res);
    if (!req || normReq === normRes || req === res) {
        return {
            kind: 'match',
            requested: req,
            returned: res,
            familyRequested: getModelFamily(req),
            familyReturned: getModelFamily(res),
            note: res === req ? '请求模型与回包模型一致。' : `名称在归一化后一致（${req} → ${res}）。`,
        };
    }

    const familyReq = getModelFamily(req);
    const familyRes = getModelFamily(res);
    const coreReq = stripSeriesDecorators(req);
    const coreRes = stripSeriesDecorators(res);

    const sameFamily = familyReq && familyRes && familyReq === familyRes;
    const prefixRelated = coreReq && coreRes && (coreReq.startsWith(coreRes) || coreRes.startsWith(coreReq) || coreReq === coreRes);
    const sharedStem = longestCommonPrefix(coreReq, coreRes);

    if (sameFamily && (prefixRelated || sharedStem.length >= Math.min(8, Math.min(coreReq.length, coreRes.length)))) {
        return {
            kind: 'series',
            requested: req,
            returned: res,
            familyRequested: familyReq,
            familyReturned: familyRes,
            note: `同系列分流：请求「${req}」，回包「${res}」。常见于带日期、high/fast/preview 等后缀的官方变体，不一定是换模型。`,
        };
    }

    if (!sameFamily && familyReq && familyRes) {
        return {
            kind: 'swap',
            requested: req,
            returned: res,
            familyRequested: familyReq,
            familyReturned: familyRes,
            note: `回包模型家族（${familyRes}）与请求（${familyReq}）不一致：${req} → ${res}。可能被路由到别家或换成了不同模型。`,
        };
    }

    // Same unknown family / weak names but very different strings
    if (levenshteinRatio(normReq, normRes) < 0.45) {
        return {
            kind: 'swap',
            requested: req,
            returned: res,
            familyRequested: familyReq,
            familyReturned: familyRes,
            note: `请求「${req}」与回包「${res}」差异很大，可能被换模型或路由。`,
        };
    }

    return {
        kind: 'series',
        requested: req,
        returned: res,
        familyRequested: familyReq,
        familyReturned: familyRes,
        note: `模型名不完全一致（${req} → ${res}），但看起来仍属相近命名。请结合延迟和 usage 自行判断。`,
    };
}

function longestCommonPrefix(a, b) {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a[i] === b[i]) {
        i += 1;
    }
    return a.slice(0, i);
}

function levenshteinRatio(a, b) {
    if (!a && !b) {
        return 1;
    }
    if (!a || !b) {
        return 0;
    }
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
    }
    return 1 - dp[m][n] / Math.max(m, n);
}

/**
 * ID prefix vs expected family.
 * Relays often mint their own IDs, so a mismatch is a soft signal only.
 */
export function analyzeIdPrefix(id, family, source) {
    const value = String(id || '').trim();
    if (!value) {
        return { present: false, expected: expectedIdHint(family, source), actual: '', note: '回包未提供 id 字段（无法获取）。' };
    }
    const expected = expectedIdHint(family, source);
    const actual = classifyIdPrefix(value);
    if (!expected) {
        return { present: true, expected, actual, note: `响应 id：${truncate(value, 48)}。当前来源没有稳定的官方前缀可供对照。` };
    }
    if (actual && expected.includes(actual)) {
        return { present: true, expected, actual, note: `响应 id 前缀（${actual}）符合 ${expected.join('/')} 家族习惯。` };
    }
    return {
        present: true,
        expected,
        actual: actual || '其他',
        note: `响应 id「${truncate(value, 48)}」前缀与常见 ${expected.join('/')} 不完全一致。中转站经常自造 id，这只能作为弱信号，不能单独认定换模型。`,
    };
}

function expectedIdHint(family, source) {
    if (source === 'openrouter') {
        return ['gen-'];
    }
    if (source === 'claude' || family === 'claude') {
        return ['msg_'];
    }
    if (source === 'openai' || source === 'azure_openai' || family === 'gpt') {
        return ['chatcmpl-', 'chatcmpl_'];
    }
    return null;
}

function classifyIdPrefix(id) {
    if (id.startsWith('chatcmpl-') || id.startsWith('chatcmpl_')) return 'chatcmpl-';
    if (id.startsWith('msg_')) return 'msg_';
    if (id.startsWith('gen-')) return 'gen-';
    if (id.startsWith('cmpl-')) return 'cmpl-';
    if (id.startsWith('resp_')) return 'resp_';
    return '';
}

/**
 * Extract a normalized metadata object from a Chat Completions-like body.
 */
export function extractResponseMeta(data) {
    if (!data || typeof data !== 'object') {
        return {
            model: '',
            id: '',
            object: '',
            usage: null,
            finishReason: '',
            text: '',
            vendorFields: [],
            rawKeys: [],
        };
    }

    const usage = normalizeUsage(data);
    const text = extractText(data);
    const vendorFields = collectVendorFields(data);
    const model = String(
        data.model
        || data.modelVersion
        || data.model_version
        || data.candidates?.[0]?.model
        || '',
    );
    const id = String(data.id || data.responseId || data.response_id || '');
    const finishReason = String(
        data.choices?.[0]?.finish_reason
        || data.stop_reason
        || data.candidates?.[0]?.finishReason
        || '',
    );

    return {
        model,
        id,
        object: String(data.object || ''),
        usage,
        finishReason,
        text,
        vendorFields,
        rawKeys: Object.keys(data),
        systemFingerprint: data.system_fingerprint || data.systemFingerprint || '',
        serviceTier: data.service_tier || '',
    };
}

function normalizeUsage(data) {
    const u = data.usage || data.usageMetadata || data.gemini_usage_metadata || data.usage_metadata || null;
    if (!u || typeof u !== 'object') {
        return null;
    }
    const prompt = firstNumber(u.prompt_tokens, u.input_tokens, u.promptTokenCount, u.prompt_token_count);
    const completion = firstNumber(u.completion_tokens, u.output_tokens, u.candidatesTokenCount, u.candidates_token_count, u.completionTokenCount);
    const total = firstNumber(u.total_tokens, u.totalTokenCount, u.total_token_count);
    const cached = firstNumber(
        u.cached_tokens,
        u.cache_read_input_tokens,
        u.prompt_tokens_details?.cached_tokens,
        u.cache_creation_input_tokens,
        u.cachedContentTokenCount,
    );
    const reasoning = firstNumber(
        u.completion_tokens_details?.reasoning_tokens,
        u.reasoning_tokens,
        u.thoughtsTokenCount,
    );
    return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: total ?? ((prompt ?? 0) + (completion ?? 0) || null),
        cached_tokens: cached,
        reasoning_tokens: reasoning,
        raw: summarizeUsageRaw(u),
        present: prompt != null || completion != null || total != null,
    };
}

function summarizeUsageRaw(u) {
    const out = {};
    for (const [key, value] of Object.entries(u)) {
        if (value !== null && typeof value !== 'object') {
            out[key] = value;
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
            out[key] = value;
        }
    }
    return out;
}

function firstNumber(...values) {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
            return Number(value);
        }
    }
    return null;
}

function extractText(data) {
    const choice = data.choices?.[0];
    if (choice?.message?.content) {
        return flattenContent(choice.message.content);
    }
    if (typeof choice?.text === 'string') {
        return choice.text;
    }
    if (typeof data.content === 'string') {
        return data.content;
    }
    if (Array.isArray(data.content)) {
        return data.content.map((part) => part?.text || part?.thinking || '').join('');
    }
    const geminiParts = data.candidates?.[0]?.content?.parts || data.responseContent?.parts;
    if (Array.isArray(geminiParts)) {
        return geminiParts.map((part) => part?.text || '').join('');
    }
    return '';
}

function flattenContent(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (typeof part === 'string') return part;
            return part?.text || part?.output_text || '';
        }).join('');
    }
    if (content && typeof content === 'object' && typeof content.text === 'string') {
        return content.text;
    }
    return '';
}

function collectVendorFields(data) {
    const fields = [];
    const checks = [
        ['usage', !!data.usage],
        ['usageMetadata / gemini_usage_metadata', !!(data.usageMetadata || data.gemini_usage_metadata || data.usage_metadata)],
        ['system_fingerprint', !!(data.system_fingerprint || data.systemFingerprint)],
        ['service_tier', !!data.service_tier],
        ['choices[].message', !!data.choices?.[0]?.message],
        ['Anthropic content / stop_reason', Array.isArray(data.content) || !!data.stop_reason],
        ['Anthropic usage.input_tokens', data.usage?.input_tokens != null],
        ['cache 字段', !!(data.usage?.prompt_tokens_details || data.usage?.cached_tokens || data.usage?.cache_read_input_tokens || data.usage?.cache_creation_input_tokens || data.usageMetadata?.cachedContentTokenCount)],
        ['思考/推理块', hasReasoning(data)],
        ['思考签名（较难伪造）', hasThinkingSignature(data)],
        ['Gemini candidates', Array.isArray(data.candidates) || !!data.responseContent],
    ];
    for (const [name, present] of checks) {
        fields.push({ name, present });
    }
    return fields;
}

function hasReasoning(data) {
    const message = data.choices?.[0]?.message;
    return !!(
        message?.reasoning
        || message?.reasoning_content
        || message?.reasoning_details
        || data.choices?.[0]?.delta?.reasoning_content
        || (Array.isArray(data.content) && data.content.some((p) => p?.type === 'thinking' || p?.thinking))
        || data.candidates?.[0]?.content?.parts?.some((p) => p?.thought)
    );
}

function hasThinkingSignature(data) {
    const message = data.choices?.[0]?.message;
    const details = message?.reasoning_details || [];
    const hasEncrypted = Array.isArray(details) && details.some((d) => d?.type === 'reasoning.encrypted' && d?.data);
    const anthropicSig = Array.isArray(data.content) && data.content.some((p) => p?.type === 'thinking' && p?.signature);
    const geminiSig = data.candidates?.[0]?.content?.parts?.some((p) => p?.thoughtSignature);
    return !!(hasEncrypted || anthropicSig || geminiSig);
}

/**
 * @param {object} usage
 * @param {number|null} estimatedPromptTokens
 * @param {string} outputText
 */
export function analyzeUsage(usage, estimatedPromptTokens, outputText) {
    if (!usage || !usage.present) {
        return {
            status: 'missing',
            note: '回包没有 usage / 用量字段。不少中转会去掉这项，只能记为「无法获取」，不能据此认定是假模型。',
        };
    }
    const notes = [];
    if (usage.prompt_tokens != null && estimatedPromptTokens != null && estimatedPromptTokens > 0) {
        const ratio = usage.prompt_tokens / estimatedPromptTokens;
        if (usage.prompt_tokens === 0) {
            notes.push(`prompt_tokens 为 0，和估算输入（约 ${estimatedPromptTokens}）对不上。`);
        } else if (ratio < 0.2 || ratio > 6) {
            notes.push(`prompt_tokens=${usage.prompt_tokens}，与估算输入约 ${estimatedPromptTokens} 相差较大（不同分词器会有偏差，仅供参考）。`);
        } else {
            notes.push(`prompt_tokens=${usage.prompt_tokens}，与估算输入约 ${estimatedPromptTokens} 大致相当。`);
        }
    } else if (usage.prompt_tokens != null) {
        notes.push(`prompt_tokens=${usage.prompt_tokens}。`);
    }
    if (usage.completion_tokens != null) {
        const outLen = (outputText || '').length;
        notes.push(`completion_tokens=${usage.completion_tokens}${outLen ? `，输出约 ${outLen} 字符` : ''}。`);
    }
    if (usage.cached_tokens != null) {
        notes.push(`发现 cache 相关用量：${usage.cached_tokens}。`);
    }
    if (usage.reasoning_tokens != null) {
        notes.push(`reasoning_tokens=${usage.reasoning_tokens}。`);
    }
    if (usage.total_tokens != null) {
        notes.push(`total_tokens=${usage.total_tokens}。`);
    }
    return { status: 'present', note: notes.join(' ') || '已返回 usage 字段。' };
}

export function analyzeLatencySpread(samples) {
    const values = (samples || []).map((s) => Number(s)).filter((n) => Number.isFinite(n) && n >= 0);
    if (values.length < 2) {
        return { note: values.length ? `单次延迟 ${Math.round(values[0])} ms。` : '没有可用的延迟样本。', spread: 0, suspicious: false };
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = max - min;
    const ratio = min > 0 ? max / min : Infinity;
    const suspicious = spread > 5000 || ratio > 3.5;
    return {
        min: Math.round(min),
        max: Math.round(max),
        spread: Math.round(spread),
        ratio: Number(ratio.toFixed(2)),
        suspicious,
        note: suspicious
            ? `多次探针延迟波动较大（${Math.round(min)}–${Math.round(max)} ms），可能存在分流、排队或不同上游。`
            : `多次探针延迟 ${Math.round(min)}–${Math.round(max)} ms，波动不大。`,
    };
}

export function isLatencyAnomaly(latencyMs, baselineMs) {
    const latency = Number(latencyMs);
    const baseline = Number(baselineMs);
    if (!Number.isFinite(latency) || latency < 0) {
        return false;
    }
    if (Number.isFinite(baseline) && baseline > 200) {
        return latency > Math.max(baseline * 3, baseline + 8000);
    }
    return latency > 30000;
}

/**
 * Combine signals into a single verdict. Never claim "this is definitely the official model".
 */
export function buildVerdict({ health, modelCompare, usageAnalysis, idAnalysis, latencyAnalysis, streamAnalysis, needleAnalysis } = {}) {
    if (health && health.ok === false) {
        return {
            verdict: VERDICT.ERROR,
            label: VERDICT_LABELS.error,
            summary: health.summary || '接口无法正常完成检测。',
        };
    }

    if (modelCompare?.kind === 'swap') {
        return {
            verdict: VERDICT.ROUTE,
            label: VERDICT_LABELS.route,
            summary: modelCompare.note,
        };
    }

    const softFlags = [];
    if (streamAnalysis?.modelMismatch) {
        softFlags.push('流式与非流式回包模型不一致');
    }
    if (latencyAnalysis?.suspicious) {
        softFlags.push('延迟波动较大');
    }
    if (needleAnalysis?.failed) {
        softFlags.push('长上下文针测未读回埋入码');
    }

    if (modelCompare?.kind === 'series' || softFlags.length >= 2) {
        const extra = softFlags.length ? `另外：${softFlags.join('；')}。` : '';
        return {
            verdict: VERDICT.SERIES,
            label: VERDICT_LABELS.series,
            summary: `${modelCompare?.note || '存在同系列或分流迹象。'}${extra}`,
        };
    }

    if (softFlags.length === 1) {
        return {
            verdict: VERDICT.SERIES,
            label: VERDICT_LABELS.series,
            summary: `${modelCompare?.note || '连通正常。'} 辅助信号：${softFlags[0]}。这不一定是换模型。`,
        };
    }

    return {
        verdict: VERDICT.OK,
        label: VERDICT_LABELS.ok,
        summary: modelCompare?.note || '当前连接可用，请求模型与回包模型一致（或回包未提供模型名）。这是辅助判断，不能 100% 证明是官方真模型。',
    };
}

export function truncate(text, max = 80) {
    const value = String(text ?? '');
    if (value.length <= max) {
        return value;
    }
    return `${value.slice(0, max)}…`;
}

export { hasThinkingSignature };
