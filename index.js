/**
 * 中转检测 — SillyTavern UI extension
 * Author: 大总管
 *
 * Checks Chat Completion / OpenAI-compatible relays via ST's own backend
 * proxy. Never sends API keys or prompts to a third party.
 */
import { getSettings, saveSettings, clearHistory, pushHistory } from './lib/store.js';
import { getConnectionSnapshot } from './lib/connection.js';
import { runQuickCheck, runDeepCheck, formatResultText, formatTime } from './lib/run.js';
import { startMonitor } from './lib/monitor.js';
import { VERDICT } from './lib/analyze.js';

const EXTENSION_FOLDER = 'third-party/sillytavern-relay-check';
const LOG_PREFIX = '[中转检测]';

let checking = false;
let uiBound = false;

export function onActivate() {
    // Slash commands should be available even if the settings drawer hasn't rendered yet.
    try {
        registerSlashCommands();
    } catch (error) {
        console.warn(`${LOG_PREFIX} 注册斜杠命令失败:`, error);
    }
}

jQuery(async () => {
    try {
        await initExtension();
    } catch (error) {
        console.error(`${LOG_PREFIX} 初始化失败:`, error);
        if (typeof toastr !== 'undefined') {
            toastr.error('中转检测扩展初始化失败，详情见控制台。', '中转检测');
        }
    }
});

async function initExtension() {
    getSettings();
    await injectSettingsPanel();
    bindSettingsUi();
    mountBadge();
    renderConnection();
    renderLastResult();
    registerSlashCommands();
    bindConnectionEvents();
    startMonitor(onMonitorUpdate);
    console.log(`${LOG_PREFIX} 已加载`);
}

async function injectSettingsPanel() {
    const ctx = SillyTavern.getContext();
    let html = '';
    const templateNames = [EXTENSION_FOLDER, 'sillytavern-relay-check'];
    if (typeof ctx.renderExtensionTemplateAsync === 'function') {
        for (const name of templateNames) {
            try {
                html = await ctx.renderExtensionTemplateAsync(name, 'settings');
                if (html) {
                    break;
                }
            } catch (error) {
                console.warn(`${LOG_PREFIX} renderExtensionTemplateAsync(${name}) 失败:`, error);
            }
        }
    }
    if (!html) {
        const urls = templateNames.map((name) => `/scripts/extensions/${name}/settings.html`);
        let lastError = null;
        for (const url of urls) {
            try {
                html = await $.get(url);
                if (html) {
                    break;
                }
            } catch (error) {
                lastError = error;
            }
        }
        if (!html) {
            console.error(`${LOG_PREFIX} 无法加载 settings.html:`, lastError);
            return;
        }
    }
    const $root = $('#extensions_settings2');
    if ($root.length) {
        $root.append(html);
    } else {
        $('#extensions_settings').append(html);
    }
}

function bindSettingsUi() {
    if (uiBound) {
        return;
    }
    const settings = getSettings();
    const $auto = $('#relay_check_auto_monitor');
    const $toast = $('#relay_check_toast');
    if ($auto.length) {
        $auto.prop('checked', !!settings.autoMonitor);
        $auto.on('input', function () {
            getSettings().autoMonitor = !!$(this).prop('checked');
            saveSettings();
        });
    }
    if ($toast.length) {
        $toast.prop('checked', settings.toastOnIssue !== false);
        $toast.on('input', function () {
            getSettings().toastOnIssue = !!$(this).prop('checked');
            saveSettings();
        });
    }
    $('#relay_check_btn_quick').on('click', () => void runCheck('quick'));
    $('#relay_check_btn_deep').on('click', () => void runCheck('deep'));
    $('#relay_check_btn_clear').on('click', () => {
        clearHistory();
        renderLastResult();
        updateBadge();
        if (typeof toastr !== 'undefined') {
            toastr.info('已清空检测记录。', '中转检测');
        }
    });
    $('#relay_check_history').on('click', '.relay-check-history-item', function () {
        const index = Number($(this).attr('data-index'));
        const entry = getSettings().history?.[index];
        if (entry) {
            renderResult(entry);
            void showResultPopup(entry);
        }
    });
    uiBound = true;
}

function mountBadge() {
    if (document.getElementById('relay_check_badge')) {
        return;
    }
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.id = 'relay_check_badge';
    badge.title = '中转检测：点击查看最近结果';
    badge.innerHTML = '<span class="relay-check-badge-dot"></span><span class="relay-check-badge-text">未检测</span>';
    badge.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const last = getSettings().lastResult;
        if (last) {
            void showResultPopup(last);
        } else {
            openSettingsDrawer();
            if (typeof toastr !== 'undefined') {
                toastr.info('还没有检测结果。可在扩展设置里点「一键检测」，或输入 /relaycheck。', '中转检测');
            }
        }
    });

    const $status = $('#API-status-top');
    if ($status.length) {
        $status.after(badge);
    } else if ($('#rm_api_block .online_status').length) {
        $('#rm_api_block .online_status').first().append(badge);
    } else if ($('#top-settings-holder').length) {
        $('#top-settings-holder').append(badge);
    } else {
        document.body.appendChild(badge);
    }
    updateBadge();
}

function openSettingsDrawer() {
    const $drawer = $('.relay-check-settings .inline-drawer');
    if (!$drawer.length) {
        return;
    }
    const $contents = $drawer.find('.inline-drawer-content');
    if ($contents.is(':hidden')) {
        $drawer.find('.inline-drawer-toggle').trigger('click');
    }
    const el = $drawer.get(0);
    if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest' });
    }
}

function bindConnectionEvents() {
    const ctx = SillyTavern.getContext();
    const { eventSource, event_types: types } = ctx;
    if (!eventSource || !types) {
        return;
    }
    const refresh = () => renderConnection();
    const names = [
        types.MAIN_API_CHANGED,
        types.CHATCOMPLETION_SOURCE_CHANGED,
        types.CHATCOMPLETION_MODEL_CHANGED,
        types.CONNECTION_PROFILE_LOADED,
        types.SETTINGS_UPDATED,
        types.ONLINE_STATUS_CHANGED,
    ].filter(Boolean);
    for (const name of names) {
        eventSource.on(name, refresh);
    }
}

function renderConnection() {
    const snap = getConnectionSnapshot();
    $('#relay_check_source').text(snap.isChatCompletion ? (snap.sourceLabel || '未知') : `非 Chat Completion（${snap.mainApi || '未知'}）`);
    $('#relay_check_model').text(snap.model || '无法获取');
    const url = snap.customUrl || (snap.reverseProxy ? snap.reverseProxy : '');
    $('#relay_check_url').text(url || '（未使用自定义地址）');
}

async function runCheck(mode) {
    if (checking) {
        if (typeof toastr !== 'undefined') {
            toastr.info('正在检测，请稍候。', '中转检测');
        }
        return null;
    }
    checking = true;
    setBusy(true);
    const ctx = SillyTavern.getContext();
    let loaderHandle = null;
    try {
        if (mode === 'deep') {
            const confirmed = await confirmDeepCheck();
            if (!confirmed) {
                return null;
            }
        }
        if (ctx.loader && typeof ctx.loader.show === 'function') {
            loaderHandle = ctx.loader.show({
                blocking: false,
                message: mode === 'deep' ? '正在进行中转深度检测…' : '正在检测当前中转连接…',
                toastMode: 'static',
            });
        }
        const onProgress = (message) => {
            if (loaderHandle && typeof loaderHandle.update === 'function') {
                try { loaderHandle.update({ message }); } catch { /* optional */ }
            }
        };
        const result = mode === 'deep' ? await runDeepCheck({ onProgress }) : await runQuickCheck({ onProgress });
        pushHistory(result);
        renderLastResult();
        updateBadge();
        toastResult(result);
        return result;
    } catch (error) {
        console.error(`${LOG_PREFIX} 检测出错:`, error);
        if (typeof toastr !== 'undefined') {
            toastr.error(error?.message || String(error), '中转检测失败');
        }
        return null;
    } finally {
        if (loaderHandle && typeof loaderHandle.hide === 'function') {
            try { await loaderHandle.hide(); } catch { /* ignore */ }
        }
        setBusy(false);
        checking = false;
    }
}

async function confirmDeepCheck() {
    const ctx = SillyTavern.getContext();
    if (ctx.Popup?.show?.confirm) {
        const result = await ctx.Popup.show.confirm(
            '深度检测会多消耗额度',
            '将额外发送回显、约 2k–4k 针测，以及流式 / 非流式对比请求。不会打超长上下文，但比一键检测更费次数。确定继续？',
        );
        // AFFIRMATIVE is typically 1; accept truthy / 1.
        return !!result;
    }
    return typeof confirm === 'function' ? confirm('深度检测会多消耗额度，确定继续？') : true;
}

function setBusy(busy) {
    $('#relay_check_btn_quick, #relay_check_btn_deep').toggleClass('disabled', busy);
}

function onMonitorUpdate(result) {
    renderLastResult();
    updateBadge();
}

function renderLastResult() {
    const settings = getSettings();
    renderResult(settings.lastResult);
    renderHistory(settings.history || []);
}

function renderResult(result) {
    const $verdict = $('#relay_check_verdict');
    const $summary = $('#relay_check_summary');
    const $items = $('#relay_check_items');
    if (!$verdict.length) {
        return;
    }
    if (!result) {
        $verdict.attr('class', 'relay-check-verdict is-unknown').text('尚未检测');
        $summary.text('点击「一键检测」或使用斜杠命令 /relaycheck、/中转检测。');
        $items.empty();
        return;
    }
    $verdict.attr('class', `relay-check-verdict is-${result.verdict || 'unknown'}`).text(result.label || '未知');
    $summary.text(result.summary || '');
    $items.empty();
    for (const item of result.items || []) {
        const $item = $('<div class="relay-check-item"></div>');
        $item.append($('<h4></h4>').text(item.title || ''));
        $item.append($('<p></p>').text(item.detail || ''));
        $items.append($item);
    }
}

function renderHistory(history) {
    const $list = $('#relay_check_history');
    if (!$list.length) {
        return;
    }
    $list.empty();
    if (!history.length) {
        $list.append($('<div class="relay-check-empty"></div>').text('暂无记录。'));
        return;
    }
    history.forEach((entry, index) => {
        const $row = $('<div class="relay-check-history-item"></div>').attr('data-index', index);
        $row.append($('<span class="relay-check-history-label"></span>').text(entry.label || '未知'));
        const mode = entry.mode === 'deep' ? '深度' : (entry.mode === 'auto' ? '监控' : '一键');
        const model = entry.metrics?.responseModel || entry.metrics?.requestedModel || '';
        $row.append($('<span class="relay-check-history-meta"></span>').text(`${mode} · ${formatTime(entry.time)}${model ? ` · ${model}` : ''}`));
        $list.append($row);
    });
}

function updateBadge() {
    const $badge = $('#relay_check_badge');
    if (!$badge.length) {
        return;
    }
    const result = getSettings().lastResult;
    const verdict = result?.verdict || VERDICT.UNKNOWN;
    const label = result?.label || '未检测';
    $badge.attr('class', `is-${verdict}`);
    $badge.find('.relay-check-badge-text').text(label);
    $badge.attr('title', result ? `中转检测：${label}。点击查看详情。` : '中转检测：尚未检测。点击查看说明。');
}

async function showResultPopup(result) {
    const ctx = SillyTavern.getContext();
    const html = buildResultHtml(result);
    try {
        if (ctx.Popup && ctx.POPUP_TYPE) {
            const popup = new ctx.Popup(html, ctx.POPUP_TYPE.TEXT, '', { okButton: '关闭', wide: true, allowVerticalScrolling: true });
            await popup.show();
            return;
        }
    } catch (error) {
        console.warn(`${LOG_PREFIX} 无法打开弹窗，回退到 toastr:`, error);
    }
    if (typeof toastr !== 'undefined') {
        toastr.info(result.summary || result.label, '中转检测');
    }
}

function buildResultHtml(result) {
    const { DOMPurify } = SillyTavern.libs || {};
    const verdictClass = `relay-check-verdict is-${result.verdict || 'unknown'}`;
    const parts = [
        `<div class="relay-check-popup">`,
        `<div class="${verdictClass}">${escapeHtml(result.label || '')}</div>`,
        `<p>${escapeHtml(result.summary || '')}</p>`,
    ];
    for (const item of result.items || []) {
        parts.push(`<div class="relay-check-item"><h4>${escapeHtml(item.title || '')}</h4><p>${escapeHtml(item.detail || '')}</p></div>`);
    }
    parts.push('</div>');
    const html = parts.join('');
    return DOMPurify?.sanitize ? DOMPurify.sanitize(html) : html;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function toastResult(result) {
    if (typeof toastr === 'undefined' || !result) {
        return;
    }
    const title = `中转检测：${result.label}`;
    if (result.verdict === VERDICT.ERROR) {
        toastr.error(result.summary, title, { timeOut: 6000 });
    } else if (result.verdict === VERDICT.ROUTE) {
        toastr.warning(result.summary, title, { timeOut: 6000 });
    } else if (result.verdict === VERDICT.SERIES) {
        toastr.info(result.summary, title, { timeOut: 5000 });
    } else {
        toastr.success(result.summary, title, { timeOut: 3500 });
    }
}

let commandsRegistered = false;

function registerSlashCommands() {
    if (commandsRegistered) {
        return;
    }
    const ctx = SillyTavern.getContext();
    const { SlashCommandParser, SlashCommand, SlashCommandNamedArgument, ARGUMENT_TYPE } = ctx;
    if (!SlashCommandParser || !SlashCommand || typeof SlashCommandParser.addCommandObject !== 'function') {
        console.warn(`${LOG_PREFIX} 当前酒馆版本没有 SlashCommandParser，跳过斜杠命令。`);
        return;
    }

    const namedArgs = [];
    if (SlashCommandNamedArgument?.fromProps && ARGUMENT_TYPE) {
        namedArgs.push(SlashCommandNamedArgument.fromProps({
            name: 'deep',
            description: '是否进行深度检测（会多消耗额度）',
            typeList: [ARGUMENT_TYPE.BOOLEAN],
            defaultValue: 'false',
            enumList: ['on', 'off', 'true', 'false'],
        }));
    }

    const command = SlashCommand.fromProps({
        name: 'relaycheck',
        aliases: ['中转检测'],
        returns: '检测结果摘要',
        namedArgumentList: namedArgs,
        helpString: `
            <div>
                检测当前 Chat Completion / OpenAI 兼容中转的连通性、是否被路由，以及协议元数据是否正常。
                加 <code>deep=on</code> 进行深度检测（会多消耗额度）。
            </div>
            <div>
                <strong>示例：</strong>
                <ul>
                    <li><pre><code class="language-stscript">/relaycheck</code></pre></li>
                    <li><pre><code class="language-stscript">/中转检测</code></pre></li>
                    <li><pre><code class="language-stscript">/relaycheck deep=on</code></pre></li>
                </ul>
            </div>
        `,
        callback: async (named) => {
            const deep = isTruthy(named?.deep);
            const result = await runCheck(deep ? 'deep' : 'quick');
            return result ? formatResultText(result) : '检测未完成。';
        },
    });
    SlashCommandParser.addCommandObject(command);
    commandsRegistered = true;
}

function isTruthy(value) {
    if (value == null) {
        return false;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'object' && typeof value.toString === 'function') {
        value = value.toString();
    }
    const text = String(value).trim().toLowerCase();
    return text === 'true' || text === 'on' || text === '1' || text === 'yes';
}
