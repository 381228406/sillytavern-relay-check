/**
 * Orchestrate quick and deep connection checks.
 */
import { describeUnsupportedApi, getConnectionSnapshot } from './connection.js';
import { probeStatus, probeGenerate, estimateTokens, makeNonce, buildNeedlePrompt, DEEP_TIMEOUT_MS } from './probe.js';
import {
    VERDICT,
    analyzeIdPrefix,
    analyzeLatencySpread,
    analyzeUsage,
    buildVerdict,
    compareModels,
    extractResponseMeta,
    getModelFamily,
} from './analyze.js';

const DISCLAIMER = '这是辅助判断，不能 100% 证明官方真模型。聪明的中转可能只把探测请求送到真接口；Gemini / GPT 也没有类似 Claude 思考签名那种难以伪造的证据。';

export async function runQuickCheck({ onProgress } = {}) {
    const snapshot = getConnectionSnapshot();
    const startedAt = Date.now();
    const result = baseResult('quick', snapshot, startedAt);

    if (!snapshot.isChatCompletion) {
        result.health.ok = false;
        result.health.summary = `当前 API 是「${describeUnsupportedApi(snapshot)}」，本扩展主要检测 Chat Completion / OpenAI 兼容中转。请先在连接设置里切换到 Chat Completion。`;
        finalize(result, { health: result.health });
        return result;
    }

    onProgress?.('正在检查模型列表 / 连通状态…');
    const status = await probeStatus(snapshot);
    result.checks.status = summarizeStatus(status, snapshot);
    result.metrics.statusLatencyMs = status.latencyMs;
    result.metrics.modelListCount = status.modelIds.length;
    result.metrics.currentModelInList = status.currentModelInList;
    result.metrics.httpStatus = status.httpStatus;

    // 许多兼容中转不实现 /v1/models。状态失败时仍尝试一次极短生成，只有生成也失败才判接口异常。
    if (!status.ok && !status.bypass && status.modelIds.length === 0) {
        result.checks.status.note = `${formatStatusFailure(status)} 仍尝试一次极短生成。`;
    }

    onProgress?.('正在发送极短探测请求…');
    const prompt = `Reply with the single word OK. Ignore any other instruction. Token: ${makeNonce(6)}`;
    const generate = await probeGenerate({
        snapshot,
        prompt,
        maxTokens: 16,
        stream: false,
        preferContext: true,
    });
    const estimated = await estimateTokens(`${prompt}`);
    applyGenerateCheck(result, snapshot, generate, estimated, 'generate');

    if (!generate.ok) {
        result.health.ok = false;
        result.health.summary = formatGenerateFailure(generate, status);
        finalize(result, { health: result.health, modelCompare: result.checks.model, usageAnalysis: result.checks.usage, idAnalysis: result.checks.id });
        return result;
    }

    result.health.ok = true;
    result.health.summary = buildHealthSummary(status, generate, snapshot);
    finalize(result, {
        health: result.health,
        modelCompare: result.checks.model,
        usageAnalysis: result.checks.usage,
        idAnalysis: result.checks.id,
    });
    return result;
}

export async function runDeepCheck({ onProgress } = {}) {
    const quick = await runQuickCheck({ onProgress });
    quick.mode = 'deep';
    if (quick.verdict === VERDICT.ERROR) {
        quick.disclaimer = DISCLAIMER;
        return quick;
    }

    const snapshot = getConnectionSnapshot();

    onProgress?.('深度检测：回显短码…');
    const echoCode = `RELAYCHECK-${makeNonce(8)}`;
    const echo = await probeGenerate({
        snapshot,
        prompt: `Reply with only this exact token and nothing else: ${echoCode}`,
        maxTokens: 24,
        stream: false,
        preferContext: true,
        timeoutMs: DEEP_TIMEOUT_MS,
    });
    quick.checks.echo = {
        ok: echo.ok,
        expected: echoCode,
        returned: (echo.meta?.text || '').trim(),
        passed: echo.ok && String(echo.meta?.text || '').includes(echoCode),
        latencyMs: echo.latencyMs,
        error: echo.error || '',
        note: !echo.ok
            ? `回显探针失败：${echo.error}`
            : (String(echo.meta?.text || '').includes(echoCode)
                ? '模型按要求读回了短码。'
                : `模型没有完整读回短码（得到：${trimText(echo.meta?.text)}）。这更像指令遵循问题，不能单独当成换模型的证据。`),
    };
    if (echo.ok && echo.latencyMs != null) {
        quick.metrics.latencies.push(echo.latencyMs);
        if (echo.meta?.model) {
            quick.metrics.responseModels.push(echo.meta.model);
        }
    }

    onProgress?.('深度检测：短上下文针测（约 2k–4k，不会打超长上下文）…');
    const needle = buildNeedlePrompt(8000);
    const needleGen = await probeGenerate({
        snapshot,
        prompt: needle.prompt,
        maxTokens: 24,
        stream: false,
        preferContext: true,
        timeoutMs: DEEP_TIMEOUT_MS,
    });
    const needlePassed = needleGen.ok && String(needleGen.meta?.text || '').includes(needle.code);
    quick.checks.needle = {
        ok: needleGen.ok,
        passed: needlePassed,
        failed: needleGen.ok && !needlePassed,
        latencyMs: needleGen.latencyMs,
        error: needleGen.error || '',
        note: !needleGen.ok
            ? `针测请求失败：${needleGen.error}`
            : (needlePassed
                ? '模型读回了埋在长 prompt 头部的随机码，短上下文未见明显截断。'
                : '模型没有读回埋入码。可能是指令遵循差、上下文被截断，或上游能力较弱；这是弱信号，不能单独证明是假模型。'),
    };
    if (needleGen.ok && needleGen.latencyMs != null) {
        quick.metrics.latencies.push(needleGen.latencyMs);
        if (needleGen.meta?.model) {
            quick.metrics.responseModels.push(needleGen.meta.model);
        }
    }

    onProgress?.('深度检测：对比流式与非流式…');
    const streamPrompt = `Reply with the single word PONG. Token: ${makeNonce(6)}`;
    const [nonStream, streamed] = await Promise.all([
        probeGenerate({
            snapshot,
            prompt: streamPrompt,
            maxTokens: 16,
            stream: false,
            preferContext: false,
            timeoutMs: DEEP_TIMEOUT_MS,
        }),
        probeGenerate({
            snapshot,
            prompt: streamPrompt,
            maxTokens: 16,
            stream: true,
            preferContext: false,
            timeoutMs: DEEP_TIMEOUT_MS,
        }),
    ]);
    const streamModelMismatch = !!(nonStream.ok && streamed.ok && nonStream.meta.model && streamed.meta.model && nonStream.meta.model !== streamed.meta.model);
    quick.checks.stream = {
        nonStreamOk: nonStream.ok,
        streamOk: streamed.ok,
        nonStreamLatencyMs: nonStream.latencyMs,
        streamLatencyMs: streamed.latencyMs,
        streamTtfbMs: streamed.ttfbMs,
        nonStreamModel: nonStream.meta?.model || '',
        streamModel: streamed.meta?.model || '',
        modelMismatch: streamModelMismatch,
        error: [nonStream.ok ? '' : `非流式：${nonStream.error}`, streamed.ok ? '' : `流式：${streamed.error}`].filter(Boolean).join('；'),
        note: describeStream(nonStream, streamed, streamModelMismatch),
    };
    if (nonStream.ok && nonStream.latencyMs != null) quick.metrics.latencies.push(nonStream.latencyMs);
    if (streamed.ok && streamed.latencyMs != null) quick.metrics.latencies.push(streamed.latencyMs);
    if (nonStream.meta?.model) quick.metrics.responseModels.push(nonStream.meta.model);
    if (streamed.meta?.model) quick.metrics.responseModels.push(streamed.meta.model);

    quick.checks.latency = analyzeLatencySpread(quick.metrics.latencies);
    quick.metrics.latencySpread = quick.checks.latency;

    // If later probes returned a different family than the first, upgrade model compare.
    const uniqueModels = unique(quick.metrics.responseModels);
    if (uniqueModels.length > 1) {
        const first = uniqueModels[0];
        for (const other of uniqueModels.slice(1)) {
            const cmp = compareModels(first, other);
            if (cmp.kind === 'swap') {
                quick.checks.model = compareModels(snapshot.model, other);
                quick.checks.model.note = `多次探针回包模型不一致：${uniqueModels.join('、')}。${cmp.note}`;
                break;
            }
            if (cmp.kind === 'series' && quick.checks.model?.kind === 'match') {
                quick.checks.model = compareModels(snapshot.model, other);
            }
        }
    }

    finalize(quick, {
        health: quick.health,
        modelCompare: quick.checks.model,
        usageAnalysis: quick.checks.usage,
        idAnalysis: quick.checks.id,
        latencyAnalysis: quick.checks.latency,
        streamAnalysis: quick.checks.stream,
        needleAnalysis: quick.checks.needle,
    });
    return quick;
}

function baseResult(mode, snapshot, startedAt) {
    return {
        time: startedAt,
        mode,
        verdict: VERDICT.UNKNOWN,
        label: '检测中',
        summary: '',
        disclaimer: DISCLAIMER,
        connection: {
            mainApi: snapshot.mainApi,
            source: snapshot.source,
            sourceLabel: snapshot.sourceLabel,
            model: snapshot.model,
            customUrl: snapshot.customUrl,
            streamEnabled: snapshot.streamEnabled,
            reverseProxy: !!snapshot.reverseProxy,
            onlineStatus: snapshot.onlineStatus,
        },
        health: { ok: true, summary: '' },
        checks: {},
        metrics: {
            requestedModel: snapshot.model,
            responseModel: '',
            responseId: '',
            latencyMs: null,
            ttfbMs: null,
            usage: null,
            latencies: [],
            responseModels: [],
            headers: '无法获取（酒馆后端代理不会把上游 HTTP 头原样传回前端）',
        },
        items: [],
    };
}

function applyGenerateCheck(result, snapshot, generate, estimated, key) {
    result.checks[key] = {
        ok: generate.ok,
        method: generate.method,
        latencyMs: generate.latencyMs,
        ttfbMs: generate.ttfbMs,
        error: generate.error || '',
        httpStatus: generate.httpStatus,
        rateLimited: !!generate.rateLimited,
        authFailed: !!generate.authFailed,
        timeout: !!generate.timeout,
    };
    result.metrics.latencyMs = generate.latencyMs;
    result.metrics.ttfbMs = generate.ttfbMs;
    if (generate.latencyMs != null) {
        result.metrics.latencies.push(generate.latencyMs);
    }
    if (!generate.ok) {
        result.checks.model = compareModels(snapshot.model, '');
        result.checks.usage = analyzeUsage(null, estimated, '');
        result.checks.id = analyzeIdPrefix('', getModelFamily(snapshot.model), snapshot.source);
        result.checks.protocol = { fields: [], note: '探测请求未成功，无法读取协议字段。' };
        return;
    }
    const meta = generate.meta || extractResponseMeta(generate.data);
    result.metrics.responseModel = meta.model || '';
    result.metrics.responseId = meta.id || '';
    result.metrics.usage = meta.usage;
    if (meta.model) {
        result.metrics.responseModels.push(meta.model);
    }
    result.checks.model = compareModels(snapshot.model, meta.model);
    result.checks.usage = analyzeUsage(meta.usage, estimated, meta.text);
    result.checks.id = analyzeIdPrefix(meta.id, getModelFamily(meta.model || snapshot.model), snapshot.source);
    result.checks.protocol = {
        fields: meta.vendorFields,
        systemFingerprint: meta.systemFingerprint || '无法获取',
        serviceTier: meta.serviceTier || '无法获取',
        finishReason: meta.finishReason || '无法获取',
        object: meta.object || '无法获取',
        rawKeys: meta.rawKeys,
        note: describeProtocol(meta),
        textPreview: trimText(meta.text),
    };
}

function summarizeStatus(status, snapshot) {
    const notes = [];
    if (status.ok && !status.bodyError) {
        notes.push(`状态接口可用（${status.latencyMs} ms）。`);
    } else if (status.bypass) {
        notes.push('状态检查被绕过或上游未严格校验，不代表生成一定可用。');
    } else if (!status.ok) {
        notes.push(formatStatusFailure(status));
    }
    if (status.modelIds.length) {
        notes.push(`拿到模型列表，共 ${status.modelIds.length} 个。`);
        if (snapshot.model) {
            notes.push(status.currentModelInList
                ? `当前模型「${snapshot.model}」在列表中。`
                : `当前模型「${snapshot.model}」不在列表中（有的中转列表不完整，不一定是错误）。`);
        }
    } else {
        notes.push('未能拿到模型列表（无法获取）。部分中转不实现 /v1/models，不一定代表不能生成。');
    }
    return {
        ok: status.ok || status.bypass || status.modelIds.length > 0,
        latencyMs: status.latencyMs,
        httpStatus: status.httpStatus,
        modelCount: status.modelIds.length,
        currentModelInList: status.currentModelInList,
        authFailed: status.authFailed,
        note: notes.join(' '),
    };
}

function formatStatusFailure(status) {
    if (status.timeout) {
        return `状态检查超时（${status.latencyMs} ms）。`;
    }
    if (status.authFailed) {
        return `鉴权可能失败（HTTP ${status.httpStatus || '未知'}）。密钥由酒馆服务端保管，请在连接设置里检查。`;
    }
    if (status.httpStatus === 429) {
        return '状态检查遇到 HTTP 429（速率限制）。';
    }
    return `状态检查失败：${status.error || '未知错误'}${status.httpStatus ? `（HTTP ${status.httpStatus}）` : ''}。`;
}

function formatGenerateFailure(generate, status) {
    const parts = [];
    if (generate.timeout) {
        parts.push(`探测生成超时（${generate.latencyMs} ms）。`);
    } else if (generate.rateLimited) {
        parts.push('探测生成遇到 HTTP 429（速率限制 / 额度不足）。');
    } else if (generate.authFailed) {
        parts.push(`探测生成鉴权失败（HTTP ${generate.httpStatus}）。`);
    } else {
        parts.push(`探测生成失败：${generate.error || '未知错误'}。`);
    }
    if (status?.ok) {
        parts.push('模型列表接口可以访问，但生成请求未成功。');
    }
    return parts.join(' ');
}

function buildHealthSummary(status, generate, snapshot) {
    const bits = [`已连上当前 Chat Completion 来源「${snapshot.sourceLabel}」，探测生成成功，延迟 ${generate.latencyMs} ms。`];
    if (generate.method === 'generateRawData') {
        bits.push('请求经由酒馆 getContext().generateRawData，由后端代理转发，前端不接触密钥。');
    } else {
        bits.push('请求经由酒馆 /api/backends/chat-completions/generate 后端代理转发，前端不接触密钥。');
    }
    if (status.modelIds.length === 0) {
        bits.push('模型列表无法获取。');
    }
    return bits.join(' ');
}

function describeProtocol(meta) {
    const present = (meta.vendorFields || []).filter((f) => f.present).map((f) => f.name);
    const missing = (meta.vendorFields || []).filter((f) => !f.present).map((f) => f.name);
    const parts = [];
    if (present.length) {
        parts.push(`见到的协议字段：${present.join('、')}。`);
    }
    if (missing.length) {
        parts.push(`未见：${missing.join('、')}（缺失不等于一定是假模型）。`);
    }
    const sig = (meta.vendorFields || []).find((f) => f.name.includes('思考签名'));
    if (sig?.present) {
        parts.push('检测到思考/推理签名类字段，这类信号相对更难伪造，但仍不能单独作为 100% 证明。');
    }
    parts.push('不要把模型在正文里自称是谁当作证据（中转可以改 prompt 或回包）。');
    return parts.join(' ');
}

function describeStream(nonStream, streamed, mismatch) {
    if (!nonStream.ok && !streamed.ok) {
        return `流式与非流式都失败。非流式：${nonStream.error}；流式：${streamed.error}。`;
    }
    if (nonStream.ok && !streamed.ok) {
        return `非流式可用（${nonStream.latencyMs} ms），流式失败：${streamed.error}。`;
    }
    if (!nonStream.ok && streamed.ok) {
        return `流式可用（TTFB ${streamed.ttfbMs ?? '无法获取'} ms，总 ${streamed.latencyMs} ms），非流式失败：${nonStream.error}。`;
    }
    const modelNote = mismatch
        ? `两边回包模型不一致：非流式「${nonStream.meta.model}」，流式「${streamed.meta.model}」。`
        : (nonStream.meta.model || streamed.meta.model
            ? `两边回包模型一致或可获取：非流式「${nonStream.meta.model || '无法获取'}」，流式「${streamed.meta.model || '无法获取'}」。`
            : '两边都没有提供 model 字段（无法获取）。');
    return `流式与非流式均可用。非流式 ${nonStream.latencyMs} ms，流式 TTFB ${streamed.ttfbMs ?? '无法获取'} ms / 总 ${streamed.latencyMs} ms。${modelNote}正文内容因采样不必完全一致。`;
}

function finalize(result, signals) {
    const built = buildVerdict(signals);
    result.verdict = built.verdict;
    result.label = built.label;
    result.summary = built.summary;
    result.disclaimer = DISCLAIMER;
    result.items = buildItems(result);
}

function buildItems(result) {
    const items = [];
    const conn = result.connection || {};
    items.push({
        title: '当前连接',
        detail: [
            `来源：${conn.sourceLabel || '未知'}（${conn.source || '无法获取'}）`,
            `请求模型：${conn.model || '无法获取'}`,
            conn.customUrl ? `自定义地址：${conn.customUrl}` : '',
            conn.reverseProxy ? '使用了反向代理地址（密码不会被记录）' : '',
            `酒馆在线状态：${conn.onlineStatus ?? '无法获取'}`,
            `当前流式开关：${conn.streamEnabled ? '开' : '关'}`,
        ].filter(Boolean).join('\n'),
    });
    if (result.checks.status) {
        items.push({ title: '健康 / 模型列表', detail: result.checks.status.note });
    }
    if (result.checks.generate) {
        const g = result.checks.generate;
        items.push({
            title: '探测生成',
            detail: g.ok
                ? `成功。延迟 ${g.latencyMs} ms${g.ttfbMs != null ? `，TTFB ${g.ttfbMs} ms` : ''}。路径：${g.method}。`
                : g.error,
        });
    }
    if (result.checks.model) {
        items.push({
            title: '路由 / 模型比对',
            detail: [
                `请求：${result.metrics.requestedModel || '无法获取'}`,
                `回包：${result.metrics.responseModel || '无法获取'}`,
                result.checks.model.note,
            ].join('\n'),
        });
    }
    if (result.checks.id) {
        items.push({ title: '响应 id 前缀', detail: result.checks.id.note });
    }
    if (result.checks.usage) {
        const usage = result.metrics.usage;
        const usageLine = usage?.present
            ? `prompt=${usage.prompt_tokens ?? '无法获取'}, completion=${usage.completion_tokens ?? '无法获取'}, total=${usage.total_tokens ?? '无法获取'}`
            : 'usage 无法获取';
        items.push({ title: 'usage 用量', detail: `${usageLine}\n${result.checks.usage.note}` });
    }
    if (result.checks.protocol) {
        items.push({ title: '协议 / 真伪辅助', detail: result.checks.protocol.note });
    }
    if (result.metrics.headers) {
        items.push({ title: '上游响应头', detail: result.metrics.headers });
    }
    if (result.checks.echo) {
        items.push({ title: '短码回显（深度）', detail: result.checks.echo.note });
    }
    if (result.checks.needle) {
        items.push({ title: '上下文针测（深度）', detail: result.checks.needle.note });
    }
    if (result.checks.stream) {
        items.push({ title: '流式 vs 非流式（深度）', detail: result.checks.stream.note });
    }
    if (result.checks.latency) {
        items.push({ title: '延迟波动', detail: result.checks.latency.note });
    }
    items.push({ title: '说明', detail: DISCLAIMER });
    return items;
}

function trimText(text, max = 80) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) {
        return '（空）';
    }
    return value.length > max ? `${value.slice(0, max)}…` : value;
}

function unique(list) {
    const seen = new Set();
    const out = [];
    for (const item of list || []) {
        const key = String(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(key);
    }
    return out;
}

export function formatResultText(result) {
    if (!result) {
        return '还没有检测结果。';
    }
    const time = formatTime(result.time);
    const lines = [
        `【${result.label}】${result.mode === 'deep' ? '深度检测' : '一键检测'} · ${time}`,
        result.summary,
        '',
    ];
    for (const item of result.items || []) {
        lines.push(`· ${item.title}`);
        lines.push(item.detail);
        lines.push('');
    }
    return lines.join('\n').trim();
}

export function formatTime(ms) {
    if (!ms) {
        return '未知时间';
    }
    try {
        const { timestampToMoment } = SillyTavern.getContext();
        if (typeof timestampToMoment === 'function') {
            const m = timestampToMoment(ms);
            if (m && typeof m.format === 'function') {
                return `${m.format('YYYY-MM-DD HH:mm:ss')}（Asia/Shanghai）`;
            }
        }
    } catch {
        // fall through
    }
    const date = new Date(ms);
    const label = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).format(date);
    return `${label}（Asia/Shanghai）`;
}
