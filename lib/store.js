/**
 * Persistent settings for the 中转检测 extension.
 * Key: relay_check — never store API keys, passwords, or full prompts.
 */
const MODULE_NAME = 'relay_check';
const HISTORY_LIMIT = 8;

const defaultSettings = Object.freeze({
    autoMonitor: true,
    toastOnIssue: true,
    history: [],
    lastResult: null,
});

export { MODULE_NAME, HISTORY_LIMIT };

export function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME] || typeof extensionSettings[MODULE_NAME] !== 'object') {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const settings = extensionSettings[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(settings, key)) {
            settings[key] = structuredClone(defaultSettings[key]);
        }
    }
    if (!Array.isArray(settings.history)) {
        settings.history = [];
    }
    return settings;
}

export function saveSettings() {
    const { saveSettingsDebounced } = SillyTavern.getContext();
    saveSettingsDebounced();
}

export function pushHistory(entry) {
    const settings = getSettings();
    const safe = sanitizeHistoryEntry(entry);
    settings.history.unshift(safe);
    if (settings.history.length > HISTORY_LIMIT) {
        settings.history.length = HISTORY_LIMIT;
    }
    settings.lastResult = safe;
    saveSettings();
    return safe;
}

export function clearHistory() {
    const settings = getSettings();
    settings.history = [];
    settings.lastResult = null;
    saveSettings();
}

function sanitizeHistoryEntry(entry) {
    const clone = structuredClone(entry ?? {});
    // Belt-and-suspenders: never persist secrets if a caller slipped them in.
    const banned = new Set(['apikey', 'api_key', 'key', 'secret', 'password', 'proxy_password', 'authorization', 'prompt', 'messages', 'custom_include_headers', 'proxyPassword', 'customincludeheaders'].map((s) => s.toLowerCase()));
    stripKeys(clone, banned);
    return clone;
}

function stripKeys(obj, banned) {
    if (!obj || typeof obj !== 'object') {
        return;
    }
    if (Array.isArray(obj)) {
        for (const item of obj) {
            stripKeys(item, banned);
        }
        return;
    }
    for (const key of Object.keys(obj)) {
        if (banned.has(String(key).toLowerCase().replace(/-/g, '_'))) {
            delete obj[key];
            continue;
        }
        stripKeys(obj[key], banned);
    }
}
