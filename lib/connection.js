/**
 * Read the currently selected Chat Completion connection.
 * Keys live in server-side Secrets and are never read here.
 */

const SOURCE_LABELS = {
    openai: 'OpenAI',
    claude: 'Claude (Anthropic)',
    openrouter: 'OpenRouter',
    ai21: 'AI21',
    makersuite: 'Google AI Studio',
    vertexai: 'Google Vertex AI',
    mistralai: 'Mistral AI',
    custom: 'Custom（OpenAI 兼容）',
    cohere: 'Cohere',
    perplexity: 'Perplexity',
    groq: 'Groq',
    electronhub: 'ElectronHub',
    chutes: 'Chutes',
    nanogpt: 'NanoGPT',
    deepseek: 'DeepSeek',
    aimlapi: 'AI/ML API',
    xai: 'xAI',
    pollinations: 'Pollinations',
    moonshot: 'Moonshot',
    fireworks: 'Fireworks',
    cometapi: 'CometAPI',
    azure_openai: 'Azure OpenAI',
    zai: 'Z.AI',
    siliconflow: 'SiliconFlow',
    workers_ai: 'Cloudflare Workers AI',
    minimax: 'MiniMax',
};

export function getConnectionSnapshot() {
    const ctx = SillyTavern.getContext();
    const mainApi = ctx.mainApi;
    const settings = ctx.chatCompletionSettings || {};
    const source = String(settings.chat_completion_source || '');
    let model = '';
    try {
        if (typeof ctx.getChatCompletionModel === 'function') {
            model = ctx.getChatCompletionModel() || '';
        }
    } catch (error) {
        console.warn('[中转检测] getChatCompletionModel failed:', error);
    }
    if (!model && source === 'custom') {
        model = settings.custom_model || '';
    }

    return {
        mainApi,
        isChatCompletion: mainApi === 'openai',
        source,
        sourceLabel: SOURCE_LABELS[source] || source || '未知',
        model: String(model || ''),
        customUrl: String(settings.custom_url || ''),
        streamEnabled: !!settings.stream_openai,
        reverseProxy: String(settings.reverse_proxy || ''),
        onlineStatus: ctx.onlineStatus ?? 'no_connection',
        azureBaseUrl: String(settings.azure_base_url || ''),
        azureDeploymentName: String(settings.azure_deployment_name || ''),
        azureApiVersion: String(settings.azure_api_version || ''),
        siliconflowEndpoint: settings.siliconflow_endpoint,
        minimaxEndpoint: settings.minimax_endpoint,
        workersAiAccountId: String(settings.workers_ai_account_id || ''),
        pollinationsEndpoint: settings.pollinations_endpoint,
        customIncludeBody: settings.custom_include_body || '',
        customExcludeBody: settings.custom_exclude_body || '',
        customIncludeHeaders: settings.custom_include_headers || '',
        proxyPassword: settings.proxy_password || '',
    };
}

/**
 * Fields needed by SillyTavern's /api/backends/chat-completions/status
 * and /generate. Includes proxy password / custom headers only so the
 * official backend proxy can authenticate — they are not stored.
 */
export function getStatusPayload(snapshot = getConnectionSnapshot()) {
    const data = {
        chat_completion_source: snapshot.source,
        reverse_proxy: snapshot.reverseProxy,
        proxy_password: snapshot.proxyPassword,
    };
    if (snapshot.source === 'custom') {
        data.custom_url = snapshot.customUrl;
        data.custom_include_headers = snapshot.customIncludeHeaders;
    }
    if (snapshot.source === 'azure_openai') {
        data.azure_base_url = snapshot.azureBaseUrl;
        data.azure_deployment_name = snapshot.azureDeploymentName;
        data.azure_api_version = snapshot.azureApiVersion;
    }
    if (snapshot.source === 'siliconflow') {
        data.siliconflow_endpoint = snapshot.siliconflowEndpoint;
    }
    if (snapshot.source === 'minimax') {
        data.minimax_endpoint = snapshot.minimaxEndpoint;
    }
    if (snapshot.source === 'workers_ai') {
        data.workers_ai_account_id = snapshot.workersAiAccountId;
    }
    if (snapshot.source === 'pollinations') {
        data.pollinations_endpoint = snapshot.pollinationsEndpoint;
    }
    return data;
}

export function getGeneratePayload(snapshot, { messages, maxTokens = 16, stream = false, temperature = 0 } = {}) {
    const data = {
        type: 'quiet',
        messages,
        model: snapshot.model,
        temperature,
        max_tokens: maxTokens,
        stream: !!stream,
        chat_completion_source: snapshot.source,
        include_reasoning: false,
    };
    if (snapshot.reverseProxy) {
        data.reverse_proxy = snapshot.reverseProxy;
        data.proxy_password = snapshot.proxyPassword;
    }
    if (snapshot.source === 'custom') {
        data.custom_url = snapshot.customUrl;
        data.custom_include_body = snapshot.customIncludeBody;
        data.custom_exclude_body = snapshot.customExcludeBody;
        data.custom_include_headers = snapshot.customIncludeHeaders;
    }
    if (snapshot.source === 'azure_openai') {
        data.azure_base_url = snapshot.azureBaseUrl;
        data.azure_deployment_name = snapshot.azureDeploymentName;
        data.azure_api_version = snapshot.azureApiVersion;
    }
    if (snapshot.source === 'siliconflow') {
        data.siliconflow_endpoint = snapshot.siliconflowEndpoint;
    }
    if (snapshot.source === 'minimax') {
        data.minimax_endpoint = snapshot.minimaxEndpoint;
    }
    if (snapshot.source === 'workers_ai') {
        data.workers_ai_account_id = snapshot.workersAiAccountId;
    }
    if (snapshot.source === 'pollinations') {
        data.pollinations_endpoint = snapshot.pollinationsEndpoint;
    }
    return data;
}

export function describeUnsupportedApi(snapshot) {
    const api = snapshot.mainApi || '未知';
    const labels = {
        kobold: 'KoboldAI / Text Completion',
        koboldhorde: 'AI Horde',
        textgenerationwebui: 'Text Completion',
        novel: 'NovelAI',
    };
    return labels[api] || api;
}

export { SOURCE_LABELS };
