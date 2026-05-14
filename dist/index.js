import crypto from "node:crypto";
import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
loadDotEnv();
const resolvedVoiceReplyMode = normalizeVoiceReplyMode(process.env.VOICE_REPLY_MODE);
const resolvedAsrProvider = normalizeAsrProvider(process.env.ASR_PROVIDER);
const config = {
    host: readEnv("HOST") ?? "0.0.0.0",
    port: readPort(process.env.PORT, 8789),
    astrbotUrl: readEnv("ASTRBOT_BRIDGE_URL") ?? "ws://127.0.0.1:8765",
    astrbotToken: readEnv("ASTRBOT_BRIDGE_TOKEN") ?? "change-me",
    appToken: readEnv("APP_TOKEN") ?? "",
    publicBaseUrl: normalizeBaseUrl(readEnv("PUBLIC_BASE_URL") ?? ""),
    voiceReplyMode: resolvedVoiceReplyMode,
    asrProvider: resolvedAsrProvider,
    asrBaseUrl: normalizeBaseUrl(readEnv("ASR_BASE_URL", "OPENAI_BASE_URL", "GEMINI_BASE_URL") ?? "https://api.openai.com/v1"),
    asrApiKey: readEnv("ASR_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY") ?? "",
    asrModel: readEnv("ASR_MODEL") ??
        (resolvedAsrProvider === "openai_transcriptions"
            ? "whisper-1"
            : (readEnv("OPENAI_MODEL", "GEMINI_MODEL") ?? "gemini-2.5-flash")),
    asrLanguage: readEnv("ASR_LANGUAGE") ?? "zh",
    mimoApiKey: readEnv("MIMO_API_KEY") ?? "",
    mimoBaseUrl: normalizeBaseUrl(readEnv("MIMO_BASE_URL") ?? "https://api.xiaomimimo.com/v1"),
    mimoTtsModel: readEnv("MIMO_TTS_MODEL") ?? "mimo-v2.5-tts",
    mimoTtsVoice: readEnv("MIMO_TTS_VOICE") ?? "Chloe",
    mimoTtsFormat: normalizeAudioFormat(process.env.MIMO_TTS_FORMAT),
    mimoTtsStyle: readEnv("MIMO_TTS_STYLE") ?? "",
    geminiApiKey: readEnv("GEMINI_API_KEY", "OPENAI_API_KEY") ?? "",
    geminiBaseUrl: normalizeBaseUrl(readEnv("GEMINI_BASE_URL", "OPENAI_BASE_URL") ?? "https://generativelanguage.googleapis.com/v1beta"),
    geminiModel: readEnv("GEMINI_MODEL", "OPENAI_MODEL") ?? "gemini-2.5-flash",
    geminiApiFormat: process.env.GEMINI_API_FORMAT === "openai" || readEnv("OPENAI_API_KEY", "OPENAI_BASE_URL") ? "openai" : "google",
    geminiOpenAiResponseFormat: process.env.GEMINI_OPENAI_RESPONSE_FORMAT === "json_object" || process.env.OPENAI_RESPONSE_FORMAT === "json_object"
        ? "json_object"
        : "none",
    voiceMaxAudioSeconds: Math.max(0, readNumber(process.env.VOICE_MAX_AUDIO_SECONDS, 0))
};
const startedAt = Date.now();
const audioDirectory = path.join(process.cwd(), "data", "audio");
const appClients = new Map();
const recentEvents = [];
const activeCalls = new Map();
let astrbotSocket = null;
let astrbotState = "idle";
let astrbotReconnectTimer = null;
let astrbotHeartbeatTimer = null;
let shuttingDown = false;
let reconnectAttempt = 0;
void mkdir(audioDirectory, { recursive: true });
const httpServer = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
        sendHttpJson(response, 200, {
            ok: true,
            app_clients: appClients.size,
            astrbot_state: astrbotState,
            astrbot_url: config.astrbotUrl,
            active_calls: activeCalls.size,
            voice_reply_mode: config.voiceReplyMode,
            asr_enabled: Boolean(config.asrApiKey),
            asr_provider: config.asrProvider,
            asr_model: config.asrModel,
            mimo_tts_enabled: Boolean(config.mimoApiKey),
            gemini_enabled: Boolean(config.geminiApiKey),
            gemini_api_format: config.geminiApiFormat,
            gemini_model: config.geminiModel,
            voice_max_audio_seconds: config.voiceMaxAudioSeconds,
            uptime_seconds: Math.floor((Date.now() - startedAt) / 1000)
        });
        return;
    }
    if (url.pathname.startsWith("/audio/")) {
        void serveAudio(url.pathname, response);
        return;
    }
    sendHttpJson(response, 404, {
        ok: false,
        error: "not_found"
    });
});
const appServer = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== "/app") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
    }
    appServer.handleUpgrade(request, socket, head, (webSocket) => {
        appServer.emit("connection", webSocket, request);
    });
});
appServer.on("connection", (socket, request) => {
    const client = {
        id: makeId("app"),
        socket,
        connectedAt: Date.now(),
        authenticated: config.appToken.length === 0,
        publicBaseUrl: publicBaseUrlFromRequest(request)
    };
    appClients.set(client.id, client);
    log(`APP connected: ${client.id}`);
    if (client.authenticated) {
        sendClientReady(client);
    }
    else {
        sendJson(socket, {
            type: "backend.auth_required",
            timestamp: Date.now()
        });
        client.authTimer = setTimeout(() => {
            if (!client.authenticated) {
                socket.close(1008, "auth required");
            }
        }, 5_000);
    }
    socket.on("message", (data) => {
        const payload = parseJsonMessage(data);
        if (!payload) {
            sendJson(socket, {
                type: "backend.error",
                error: "invalid_json",
                timestamp: Date.now()
            });
            return;
        }
        if (!client.authenticated) {
            handleAppAuth(client, payload);
            return;
        }
        handleAppMessage(client, payload);
    });
    socket.on("close", () => {
        if (client.authTimer) {
            clearTimeout(client.authTimer);
        }
        appClients.delete(client.id);
        log(`APP disconnected: ${client.id}`);
    });
    socket.on("error", (error) => {
        log(`APP socket error ${client.id}: ${error.message}`);
    });
});
function handleAppAuth(client, payload) {
    const type = readString(payload.type, "unknown");
    const token = readString(payload.token);
    if (type !== "auth" || token !== config.appToken) {
        sendJson(client.socket, {
            type: "backend.auth_failed",
            timestamp: Date.now()
        });
        client.socket.close(1008, "invalid token");
        return;
    }
    client.authenticated = true;
    if (client.authTimer) {
        clearTimeout(client.authTimer);
        client.authTimer = undefined;
    }
    sendClientReady(client);
}
function sendClientReady(client) {
    sendJson(client.socket, {
        type: "backend.ready",
        client_id: client.id,
        astrbot_state: astrbotState,
        app_clients: appClients.size,
        active_calls: activeCalls.size,
        timestamp: Date.now()
    });
    sendJson(client.socket, {
        type: "backend.snapshot",
        recent_events: recentEvents.slice(-20),
        timestamp: Date.now()
    });
}
function handleAppMessage(client, payload) {
    const type = readString(payload.type, "unknown");
    if (type === "ping") {
        sendJson(client.socket, {
            type: "pong",
            timestamp: Date.now()
        });
        return;
    }
    if (type === "app.ready") {
        sendClientReady(client);
        return;
    }
    if (type === "app.message" || type === "app.user_text") {
        void handleAppUserText(client, payload, type === "app.message" ? "text" : readString(payload.input_mode, "text"));
        return;
    }
    if (type === "app.user_audio") {
        void handleAppUserAudio(client, payload);
        return;
    }
    if (type === "app.call.outgoing") {
        handleAppOutgoingCall(client, payload);
        return;
    }
    if (type === "app.call.accept" || type === "app.call.end") {
        const callId = readString(payload.call_id);
        const call = activeCalls.get(callId);
        const bridgeEvent = {
            ...payload,
            client_id: client.id,
            timestamp: Date.now()
        };
        if (type === "app.call.end") {
            if (call) {
                void writeBackCallSummary(call, readString(payload.status, "ended"));
            }
            activeCalls.delete(callId);
        }
        rememberEvent(bridgeEvent);
        sendToAstrBot(bridgeEvent);
        broadcastToApps(bridgeEvent, client.id);
        return;
    }
    log(`APP message ignored: ${type}`);
}
function handleAppOutgoingCall(client, payload) {
    const callId = readString(payload.call_id, makeId("call")).trim() || makeId("call");
    const unifiedMsgOrigin = readString(payload.unified_msg_origin).trim();
    const title = readString(payload.title, "粟茗").trim() || "粟茗";
    const reason = readString(payload.reason, "APP 主动拨号。").trim() || "APP 主动拨号。";
    const openingLine = readString(payload.opening_line, "我已经接通了。你那边听得到我吗？").trim() ||
        "我已经接通了。你那边听得到我吗？";
    if (!unifiedMsgOrigin) {
        const errorEvent = {
            type: "voice.error",
            call_id: callId,
            message: "联系人缺少 AstrBot 会话 ID，无法主动拨号。",
            timestamp: Date.now()
        };
        rememberEvent(errorEvent);
        sendJson(client.socket, errorEvent);
        return;
    }
    const session = {
        unified_msg_origin: unifiedMsgOrigin,
        sender: {
            name: title
        },
        message_str: "[APP 主动拨号]",
        platform: "app"
    };
    activeCalls.set(callId, {
        callId,
        unifiedMsgOrigin,
        session,
        astrbotContext: {},
        turns: [
            {
                role: "assistant",
                text: openingLine,
                at: Date.now()
            }
        ],
        startedAt: Date.now()
    });
    const bridgeEvent = {
        type: "app.call.outgoing",
        call_id: callId,
        unified_msg_origin: unifiedMsgOrigin,
        title,
        reason,
        opening_line: openingLine,
        client_id: client.id,
        timestamp: Date.now()
    };
    rememberEvent(bridgeEvent);
    if (!sendToAstrBot(bridgeEvent)) {
        const errorEvent = {
            type: "voice.error",
            call_id: callId,
            message: "AstrBot 插件还没有连接，主动拨号无法进入 AstrBot 会话。",
            timestamp: Date.now()
        };
        activeCalls.delete(callId);
        rememberEvent(errorEvent);
        sendJson(client.socket, errorEvent);
        return;
    }
    const startedEvent = {
        type: "call.outgoing.started",
        call_id: callId,
        unified_msg_origin: unifiedMsgOrigin,
        title,
        reason,
        opening_line: openingLine,
        timestamp: Date.now()
    };
    rememberEvent(startedEvent);
    sendJson(client.socket, startedEvent);
    log(`Outgoing APP call forwarded to AstrBot: call=${callId} origin=${unifiedMsgOrigin}`);
}
async function handleAppUserText(client, payload, inputMode) {
    const text = readString(payload.text).trim();
    const requestId = readString(payload.request_id, makeId("req"));
    const callId = readString(payload.call_id) || latestActiveCallId();
    if (!text) {
        sendJson(client.socket, {
            type: "voice.error",
            request_id: requestId,
            call_id: callId,
            message: "没有可发送的文字。",
            timestamp: Date.now()
        });
        return;
    }
    const call = activeCalls.get(callId);
    if (!call) {
        sendJson(client.socket, {
            type: "voice.error",
            request_id: requestId,
            call_id: callId,
            message: "没有找到当前通话，请先由 AstrBot 发起来电并接听。",
            timestamp: Date.now()
        });
        return;
    }
    if (config.voiceReplyMode === "astrbot") {
        call.turns.push({
            role: "user",
            text: inputMode === "speech" ? `用户语音转写：${text}` : `用户文字：${text}`,
            at: Date.now()
        });
        log(`Voice route: APP ${inputMode} text -> AstrBot agent -> MiMo TTS, call=${call.callId} request=${requestId}`);
        forwardTextToAstrBot(call, client, requestId, text, inputMode);
        return;
    }
    log(`Voice route: APP ${inputMode} text -> backend_model (${config.geminiModel}) -> MiMo TTS, call=${call.callId} request=${requestId}`);
    const acceptedEvent = {
        type: "voice.user_text.accepted",
        request_id: requestId,
        call_id: callId,
        text,
        input_mode: inputMode,
        timestamp: Date.now()
    };
    rememberEvent(acceptedEvent);
    sendJson(client.socket, acceptedEvent);
    await generateAndSendGeminiReply(call, client, requestId, {
        text,
        inputMode
    });
}
async function handleAppUserAudio(client, payload) {
    const requestId = readString(payload.request_id, makeId("req"));
    const callId = readString(payload.call_id) || latestActiveCallId();
    const audio = readObject(payload.audio);
    const data = readString(audio.data);
    const mimeType = readString(audio.mime_type, "audio/wav");
    const durationMs = readNumber(audio.duration_ms, 0);
    if (!data) {
        sendJson(client.socket, {
            type: "voice.error",
            request_id: requestId,
            call_id: callId,
            message: "APP 没有上传录音数据。",
            timestamp: Date.now()
        });
        return;
    }
    let audioBuffer;
    try {
        audioBuffer = Buffer.from(data, "base64");
    }
    catch {
        sendJson(client.socket, {
            type: "voice.error",
            request_id: requestId,
            call_id: callId,
            message: "录音数据不是合法的 base64。",
            timestamp: Date.now()
        });
        return;
    }
    if (audioBuffer.byteLength < 300 || audioBuffer.byteLength > 12 * 1024 * 1024) {
        sendJson(client.socket, {
            type: "voice.error",
            request_id: requestId,
            call_id: callId,
            message: "录音太短或太大，后端没有处理。",
            timestamp: Date.now()
        });
        return;
    }
    if (!mimeType.includes("wav")) {
        sendJson(client.socket, {
            type: "voice.error",
            request_id: requestId,
            call_id: callId,
            message: "当前后端只接收 APP 上传的 audio/wav 语音。",
            timestamp: Date.now()
        });
        return;
    }
    if (config.voiceMaxAudioSeconds > 0 && durationMs > config.voiceMaxAudioSeconds * 1000 + 1000) {
        sendJson(client.socket, {
            type: "voice.error",
            request_id: requestId,
            call_id: callId,
            message: `单段语音最长 ${config.voiceMaxAudioSeconds} 秒，请说短一点再发送。`,
            timestamp: Date.now()
        });
        return;
    }
    const call = activeCalls.get(callId);
    if (!call) {
        sendJson(client.socket, {
            type: "voice.error",
            request_id: requestId,
            call_id: callId,
            message: "没有找到当前通话，请先由 AstrBot 发起来电并接听。",
            timestamp: Date.now()
        });
        return;
    }
    const acceptedEvent = {
        type: "voice.user_audio.accepted",
        request_id: requestId,
        call_id: callId,
        duration_ms: durationMs,
        size: audioBuffer.byteLength,
        timestamp: Date.now()
    };
    rememberEvent(acceptedEvent);
    sendJson(client.socket, acceptedEvent);
    if (config.voiceReplyMode === "astrbot") {
        try {
            log(`Voice route: APP audio -> ASR (${config.asrModel}) -> AstrBot agent -> MiMo TTS, call=${call.callId} request=${requestId}`);
            const text = await transcribeAudio({
                data,
                mimeType,
                durationMs
            });
            if (!text) {
                throw new Error("ASR 没有返回可用文字。");
            }
            const transcribedEvent = {
                type: "voice.user_audio.transcribed",
                request_id: requestId,
                call_id: callId,
                text,
                duration_ms: durationMs,
                timestamp: Date.now()
            };
            rememberEvent(transcribedEvent);
            broadcastToApps(transcribedEvent);
            log(`ASR transcript accepted: call=${call.callId} request=${requestId} text=${compactLogText(text)}`);
            call.turns.push({
                role: "user",
                text: `用户语音转写：${text}`,
                at: Date.now(),
                durationMs
            });
            forwardTextToAstrBot(call, client, requestId, text, "speech");
        }
        catch (error) {
            const errorEvent = {
                type: "voice.error",
                request_id: requestId,
                call_id: callId,
                message: `ASR 转写失败：${error instanceof Error ? error.message : String(error)}`,
                timestamp: Date.now()
            };
            rememberEvent(errorEvent);
            sendJson(client.socket, errorEvent);
            log(readString(errorEvent.message));
        }
        return;
    }
    log(`Voice route: APP audio -> backend_model (${config.geminiModel}) -> MiMo TTS, call=${call.callId} request=${requestId}`);
    await generateAndSendGeminiReply(call, client, requestId, {
        audio: {
            data,
            mimeType,
            durationMs
        },
        inputMode: "speech"
    });
}
function forwardTextToAstrBot(call, client, requestId, text, inputMode) {
    if (astrbotState !== "ready") {
        const errorEvent = {
            type: "voice.error",
            request_id: requestId,
            call_id: call.callId,
            message: "AstrBot 插件还没有连接就绪，无法把这句话交给 AstrBot。",
            timestamp: Date.now()
        };
        rememberEvent(errorEvent);
        sendJson(client.socket, errorEvent);
        return;
    }
    const payload = {
        type: "app.user_text",
        request_id: requestId,
        call_id: call.callId,
        unified_msg_origin: call.unifiedMsgOrigin,
        text,
        input_mode: inputMode,
        sync_to_qq: false,
        timestamp: Date.now()
    };
    if (!sendToAstrBot(payload)) {
        const errorEvent = {
            type: "voice.error",
            request_id: requestId,
            call_id: call.callId,
            message: "发送到 AstrBot 插件失败，WebSocket 已断开。",
            timestamp: Date.now()
        };
        rememberEvent(errorEvent);
        sendJson(client.socket, errorEvent);
        return;
    }
    rememberEvent(payload);
    log(`Forwarded ${inputMode} text to AstrBot agent: call=${call.callId} request=${requestId}`);
}
function connectAstrBot() {
    if (shuttingDown || astrbotState === "connecting" || astrbotState === "connected" || astrbotState === "ready") {
        return;
    }
    astrbotState = "connecting";
    log(`Connecting AstrBot bridge: ${config.astrbotUrl}`);
    const socket = new WebSocket(config.astrbotUrl);
    astrbotSocket = socket;
    socket.on("open", () => {
        astrbotState = "connected";
        log("AstrBot socket connected, sending auth token");
        sendJson(socket, {
            type: "auth",
            token: config.astrbotToken
        });
        startAstrBotHeartbeat();
        broadcastToApps({
            type: "backend.astrbot_state",
            state: astrbotState,
            timestamp: Date.now()
        });
    });
    socket.on("message", (data) => {
        const payload = parseJsonMessage(data);
        if (!payload) {
            log("AstrBot sent invalid JSON");
            return;
        }
        handleAstrBotPayload(payload);
    });
    socket.on("close", (code, reason) => {
        if (astrbotSocket === socket) {
            astrbotSocket = null;
        }
        stopAstrBotHeartbeat();
        astrbotState = shuttingDown ? "closed" : "idle";
        const reasonText = reason.toString("utf8") || "no reason";
        log(`AstrBot socket closed: code=${code} reason=${reasonText}`);
        broadcastToApps({
            type: "backend.astrbot_state",
            state: astrbotState,
            timestamp: Date.now()
        });
        scheduleAstrBotReconnect();
    });
    socket.on("error", (error) => {
        log(`AstrBot socket error: ${error.message}`);
    });
}
function handleAstrBotPayload(payload) {
    if (payload.type === "bridge.ready") {
        reconnectAttempt = 0;
        astrbotState = "ready";
        log("AstrBot bridge ready");
    }
    if (payload.type === "call.start") {
        rememberActiveCall(payload);
    }
    rememberEvent(payload);
    broadcastToApps(payload);
    if (payload.type === "voice.reply.text") {
        const callId = readString(payload.call_id);
        const text = readString(payload.text).trim();
        const call = activeCalls.get(callId);
        if (call && text) {
            call.turns.push({
                role: "assistant",
                text,
                at: Date.now()
            });
        }
        log(`AstrBot reply received, starting TTS: call=${callId} text=${compactLogText(text)}`);
        void synthesizeReply(payload);
    }
}
function rememberActiveCall(payload) {
    const callId = readString(payload.call_id);
    const session = (payload.session && typeof payload.session === "object" ? payload.session : {});
    const rootContext = readObject(payload.astrbot_context);
    const sessionContext = readObject(session.astrbot_context);
    const astrbotContext = Object.keys(rootContext).length ? rootContext : sessionContext;
    const unifiedMsgOrigin = readString(session.unified_msg_origin);
    if (!callId || !unifiedMsgOrigin) {
        return;
    }
    activeCalls.set(callId, {
        callId,
        unifiedMsgOrigin,
        session,
        astrbotContext,
        turns: [],
        startedAt: Date.now()
    });
}
async function writeBackCallSummary(call, status) {
    if (!call.turns.length) {
        return;
    }
    const summary = await summarizeCall(call, status);
    const event = {
        type: "call.summary.writeback",
        call_id: call.callId,
        unified_msg_origin: call.unifiedMsgOrigin,
        summary,
        status,
        started_at: call.startedAt,
        ended_at: Date.now(),
        timestamp: Date.now()
    };
    rememberEvent(event);
    sendToAstrBot(event);
}
async function summarizeCall(call, status) {
    const localSummary = buildLocalCallSummary(call, status);
    if (!config.geminiApiKey) {
        return localSummary;
    }
    try {
        const prompt = [
            "请把下面这通语音电话整理成一段可以写回聊天记忆的中文总结。",
            "格式包含：通话时间、聊了什么、用户表达的重点、助手回应的重点、后续记忆。",
            "只能依据逐轮记录总结，不要补充模型身份，不要写 Gemini、Google、OpenAI、后端模型等技术来源。",
            "如果用户问过助手身份，只总结为“用户询问了助手身份”，不要替助手重新回答身份。",
            "不要写完整逐字稿，控制在 220 字以内。",
            "",
            localSummary
        ].join("\n");
        return (await generateGeminiText(prompt, 0.4)) || localSummary;
    }
    catch (error) {
        log(`Call summary fallback: ${error instanceof Error ? error.message : String(error)}`);
        return localSummary;
    }
}
function buildLocalCallSummary(call, status) {
    const started = new Date(call.startedAt).toLocaleString("zh-CN");
    const turns = stringifyVoiceTurns(call.turns);
    return [
        `语音通话时间：${started}`,
        `通话状态：${status}`,
        "本次通话简要记录：",
        turns
    ].join("\n");
}
async function generateAndSendGeminiReply(call, client, requestId, input) {
    if (config.voiceReplyMode === "astrbot") {
        const errorEvent = {
            type: "voice.error",
            request_id: requestId,
            call_id: call.callId,
            message: "当前是 AstrBot 回复模式，后端不会直接调用后端模型生成回复。",
            timestamp: Date.now()
        };
        rememberEvent(errorEvent);
        sendJson(client.socket, errorEvent);
        log("Blocked backend_model reply because VOICE_REPLY_MODE=astrbot");
        return;
    }
    log(`Backend model reply enabled explicitly: model=${config.geminiModel}, call=${call.callId}, request=${requestId}`);
    const pendingEvent = {
        type: "voice.reply.pending",
        request_id: requestId,
        call_id: call.callId,
        timestamp: Date.now()
    };
    rememberEvent(pendingEvent);
    sendJson(client.socket, pendingEvent);
    if (!config.geminiApiKey) {
        const errorEvent = {
            type: "voice.error",
            request_id: requestId,
            call_id: call.callId,
            message: "后端模型模式没有配置 GEMINI_API_KEY / OPENAI_API_KEY，不能直接生成语音回复。",
            timestamp: Date.now()
        };
        rememberEvent(errorEvent);
        sendJson(client.socket, errorEvent);
        return;
    }
    try {
        const result = await generateGeminiVoiceReply(call, input);
        const userNote = result.userNote || (input.text ? `用户文字：${input.text}` : `用户发送了 ${Math.round((input.audio?.durationMs ?? 0) / 1000)} 秒语音。`);
        call.turns.push({
            role: "user",
            text: userNote,
            at: Date.now(),
            durationMs: input.audio?.durationMs
        });
        call.turns.push({
            role: "assistant",
            text: result.reply,
            at: Date.now()
        });
        const replyEvent = {
            type: "voice.reply.text",
            request_id: requestId,
            call_id: call.callId,
            text: result.reply,
            timestamp: Date.now()
        };
        rememberEvent(replyEvent);
        broadcastToApps(replyEvent);
        await synthesizeReply(replyEvent);
    }
    catch (error) {
        const errorEvent = {
            type: "voice.error",
            request_id: requestId,
            call_id: call.callId,
            message: `后端模型语音回复失败：${error instanceof Error ? error.message : String(error)}`,
            timestamp: Date.now()
        };
        rememberEvent(errorEvent);
        sendJson(client.socket, errorEvent);
        log(readString(errorEvent.message));
    }
}
async function generateGeminiVoiceReply(call, input) {
    const prompt = [
        "你正在和用户进行一通 APP 内语音电话。请自然、简短、像电话里聊天一样回复。",
        "不要说自己看不到或听不到音频；如果音频里内容不清楚，请温柔地让用户再说一次。",
        "请只返回 JSON：{\"reply\":\"给用户播放和展示的回复\",\"user_note\":\"对用户这轮语音/文字的简短记忆，不要超过60字\"}。",
        "",
        "AstrBot 文字聊天上下文：",
        stringifyAstrBotContext(call),
        "",
        "本次电话已经发生的轮次：",
        stringifyVoiceTurns(call.turns),
        "",
        input.audio ? `用户现在发来一段 ${Math.round(input.audio.durationMs / 1000)} 秒 WAV 语音，请听懂后回复。` : `用户现在发来文字：${input.text ?? ""}`
    ].join("\n");
    const rawText = await generateGeminiMultimodal(prompt, input.audio, 0.8, true);
    const parsed = parseGeminiReply(rawText);
    if (!parsed.reply) {
        throw new Error("Gemini 没有返回可播放的回复。");
    }
    return parsed;
}
async function generateGeminiText(prompt, temperature) {
    return generateGeminiMultimodal(prompt, undefined, temperature, false);
}
async function generateGeminiMultimodal(prompt, audio, temperature, preferJson) {
    if (config.geminiApiFormat === "openai") {
        return generateOpenAiCompatible(prompt, audio, temperature, preferJson);
    }
    return generateGoogleGemini(prompt, audio, temperature, preferJson);
}
async function generateGoogleGemini(prompt, audio, temperature, preferJson) {
    const parts = [{ text: prompt }];
    if (audio) {
        parts.push({
            inlineData: {
                mimeType: audio.mimeType,
                data: audio.data
            }
        });
    }
    const response = await fetch(`${config.geminiBaseUrl}/${geminiModelPath()}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`, {
        method: "POST",
        headers: {
            "content-type": "application/json"
        },
        body: JSON.stringify({
            contents: [
                {
                    role: "user",
                    parts
                }
            ],
            generationConfig: {
                ...(preferJson ? { responseMimeType: "application/json" } : {}),
                temperature
            }
        })
    });
    const json = (await response.json().catch(async () => ({ error: { message: await response.text() } })));
    if (!response.ok) {
        throw new Error(json.error?.message ?? `HTTP ${response.status}`);
    }
    return extractGeminiText(json);
}
async function generateOpenAiCompatible(prompt, audio, temperature, preferJson) {
    const content = [{ type: "text", text: prompt }];
    if (audio) {
        content.push({
            type: "input_audio",
            input_audio: {
                data: audio.data,
                format: "wav"
            }
        });
    }
    const body = {
        model: config.geminiModel,
        messages: [
            {
                role: "user",
                content
            }
        ],
        temperature
    };
    if (preferJson && config.geminiOpenAiResponseFormat === "json_object") {
        body.response_format = { type: "json_object" };
    }
    const response = await fetch(`${config.geminiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${config.geminiApiKey}`,
            "content-type": "application/json"
        },
        body: JSON.stringify(body)
    });
    const json = (await response.json().catch(async () => ({ error: { message: await response.text() } })));
    if (!response.ok) {
        throw new Error(json.error?.message ?? `HTTP ${response.status}`);
    }
    return extractOpenAiText(json);
}
async function transcribeAudio(audio) {
    if (!config.asrApiKey) {
        throw new Error("后端没有配置 ASR_API_KEY / OPENAI_API_KEY，无法把语音转成文字。");
    }
    const text = config.asrProvider === "openai_transcriptions"
        ? await transcribeWithOpenAiTranscriptions(audio)
        : await transcribeWithOpenAiChatAudio(audio);
    const cleaned = cleanTranscription(text);
    if (looksLikeModelAnswer(cleaned)) {
        throw new Error("ASR 疑似返回了模型回答而不是语音转写，请换支持转写的 ASR 模型或改用 openai_transcriptions。");
    }
    return cleaned;
}
async function transcribeWithOpenAiChatAudio(audio) {
    const content = [
        {
            type: "text",
            text: [
                "你是严格的语音转写器，不是聊天助手。",
                "唯一任务：把音频里的用户原话逐字转写成简体中文文本。",
                "禁止回答音频里的问题，禁止解释，禁止自我介绍，禁止输出“我是 Gemini/OpenAI/语言模型”。",
                "例如音频里问“你是谁”，你只能输出“你是谁”，不能回答你是谁。",
                "如果听不清或没有人声，只输出空字符串。"
            ].join("\n")
        },
        {
            type: "input_audio",
            input_audio: {
                data: audio.data,
                format: "wav"
            }
        }
    ];
    const response = await fetch(`${config.asrBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${config.asrApiKey}`,
            "content-type": "application/json"
        },
        body: JSON.stringify({
            model: config.asrModel,
            messages: [
                {
                    role: "user",
                    content
                }
            ],
            temperature: 0
        })
    });
    const json = (await response.json().catch(async () => ({ error: { message: await response.text() } })));
    if (!response.ok) {
        throw new Error(json.error?.message ?? `HTTP ${response.status}`);
    }
    return extractOpenAiText(json);
}
async function transcribeWithOpenAiTranscriptions(audio) {
    const form = new FormData();
    const audioBytes = Uint8Array.from(Buffer.from(audio.data, "base64"));
    form.append("file", new Blob([audioBytes], { type: audio.mimeType }), "voice.wav");
    form.append("model", config.asrModel);
    if (config.asrLanguage) {
        form.append("language", config.asrLanguage);
    }
    form.append("response_format", "json");
    const response = await fetch(`${config.asrBaseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${config.asrApiKey}`
        },
        body: form
    });
    const bodyText = await response.text();
    let parsed = {};
    try {
        parsed = JSON.parse(bodyText);
    }
    catch {
        parsed = {};
    }
    if (!response.ok) {
        throw new Error(readString(parsed.error && typeof parsed.error === "object" ? parsed.error.message : "") || bodyText.slice(0, 240) || `HTTP ${response.status}`);
    }
    return readString(parsed.text, bodyText).trim();
}
function cleanTranscription(value) {
    const cleaned = value
        .replace(/^```(?:text|json)?/i, "")
        .replace(/```$/i, "")
        .replace(/^["“”']+|["“”']+$/g, "")
        .replace(/^(转写|文本|transcript)\s*[:：]\s*/i, "")
        .trim();
    return /^(空字符串|无|没有|听不清|无法识别)$/i.test(cleaned) ? "" : cleaned;
}
function looksLikeModelAnswer(value) {
    if (!value) {
        return false;
    }
    return /我是.*(Gemini|OpenAI|语言模型|人工智能|AI 助手|AI助手)|由\s*(Google|OpenAI)\s*训练|作为.*(Gemini|语言模型|AI)|有什么我可以帮/i.test(value);
}
function extractGeminiText(json) {
    return json.candidates?.[0]?.content?.parts?.map((part) => readString(part.text)).join("").trim() ?? "";
}
function extractOpenAiText(json) {
    const content = json.choices?.[0]?.message?.content;
    if (typeof content === "string") {
        return content.trim();
    }
    if (Array.isArray(content)) {
        return content.map((part) => readString(part.text)).join("").trim();
    }
    return "";
}
function parseGeminiReply(rawText) {
    const cleaned = rawText.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    const jsonStart = cleaned.indexOf("{");
    const jsonEnd = cleaned.lastIndexOf("}");
    const candidate = jsonStart >= 0 && jsonEnd > jsonStart ? cleaned.slice(jsonStart, jsonEnd + 1) : cleaned;
    try {
        const parsed = JSON.parse(candidate);
        return {
            reply: readString(parsed.reply).trim(),
            userNote: readString(parsed.user_note).trim()
        };
    }
    catch {
        return {
            reply: cleaned,
            userNote: ""
        };
    }
}
function stringifyAstrBotContext(call) {
    const history = call.astrbotContext.history;
    if (Array.isArray(history) && history.length) {
        return history
            .slice(-12)
            .map((item, index) => `${index + 1}. ${compactJson(item)}`)
            .join("\n")
            .slice(0, 6000);
    }
    return compactJson(call.session).slice(0, 4000);
}
function stringifyVoiceTurns(turns) {
    if (!turns.length) {
        return "还没有电话内对话。";
    }
    return turns
        .slice(-10)
        .map((turn) => `${turn.role === "user" ? "用户" : "助手"}：${turn.text}`)
        .join("\n")
        .slice(0, 4000);
}
function compactJson(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
function compactLogText(value) {
    const compacted = value.replace(/\s+/g, " ").trim();
    return compacted.length > 120 ? `${compacted.slice(0, 117)}...` : compacted;
}
async function synthesizeReply(payload) {
    const requestId = readString(payload.request_id, makeId("req"));
    const callId = readString(payload.call_id);
    const text = readString(payload.text).trim();
    if (!text) {
        return;
    }
    if (!config.mimoApiKey) {
        const errorEvent = {
            type: "voice.error",
            request_id: requestId,
            call_id: callId,
            message: "后端没有配置 MIMO_API_KEY，已只返回文字。",
            timestamp: Date.now()
        };
        rememberEvent(errorEvent);
        broadcastToApps(errorEvent);
        return;
    }
    try {
        const fileName = await synthesizeWithMimo(requestId, text);
        const audioEvent = {
            type: "voice.assistant.audio",
            request_id: requestId,
            call_id: callId,
            text,
            audio_url: `${resolvePublicBaseUrl()}/audio/${fileName}`,
            audio_format: config.mimoTtsFormat,
            timestamp: Date.now()
        };
        rememberEvent(audioEvent);
        broadcastToApps(audioEvent);
    }
    catch (error) {
        const errorEvent = {
            type: "voice.error",
            request_id: requestId,
            call_id: callId,
            message: `MiMo TTS 合成失败：${error instanceof Error ? error.message : String(error)}`,
            timestamp: Date.now()
        };
        rememberEvent(errorEvent);
        broadcastToApps(errorEvent);
        log(readString(errorEvent.message));
    }
}
async function synthesizeWithMimo(requestId, text) {
    const messages = [];
    if (config.mimoTtsStyle.trim()) {
        messages.push({ role: "user", content: config.mimoTtsStyle.trim() });
    }
    messages.push({ role: "assistant", content: text });
    const response = await fetch(`${config.mimoBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            "api-key": config.mimoApiKey,
            "content-type": "application/json"
        },
        body: JSON.stringify({
            model: config.mimoTtsModel,
            messages,
            audio: {
                format: config.mimoTtsFormat,
                voice: config.mimoTtsVoice
            }
        })
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status} ${body.slice(0, 240)}`);
    }
    const json = (await response.json());
    const audioData = json.choices?.[0]?.message?.audio?.data;
    if (!audioData) {
        throw new Error("返回结果里没有 choices[0].message.audio.data。");
    }
    const fileName = `${safeId(requestId)}-${Date.now()}.${config.mimoTtsFormat}`;
    await mkdir(audioDirectory, { recursive: true });
    await writeFile(path.join(audioDirectory, fileName), Buffer.from(audioData, "base64"));
    return fileName;
}
async function serveAudio(pathname, response) {
    const fileName = pathname.replace(/^\/audio\//, "");
    if (!/^[a-zA-Z0-9_-]+\.(wav|mp3)$/.test(fileName)) {
        sendHttpJson(response, 400, { ok: false, error: "invalid_audio_name" });
        return;
    }
    try {
        const file = await readFile(path.join(audioDirectory, fileName));
        response.writeHead(200, {
            "content-type": fileName.endsWith(".mp3") ? "audio/mpeg" : "audio/wav",
            "content-length": file.byteLength,
            "cache-control": "public, max-age=86400",
            "access-control-allow-origin": "*"
        });
        response.end(file);
    }
    catch {
        sendHttpJson(response, 404, { ok: false, error: "audio_not_found" });
    }
}
function sendToAstrBot(payload) {
    if (!astrbotSocket || astrbotSocket.readyState !== WebSocket.OPEN) {
        return false;
    }
    sendJson(astrbotSocket, payload);
    return true;
}
function scheduleAstrBotReconnect() {
    if (shuttingDown || astrbotReconnectTimer) {
        return;
    }
    reconnectAttempt += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 5));
    log(`AstrBot reconnect in ${delay}ms`);
    astrbotReconnectTimer = setTimeout(() => {
        astrbotReconnectTimer = null;
        connectAstrBot();
    }, delay);
}
function startAstrBotHeartbeat() {
    stopAstrBotHeartbeat();
    astrbotHeartbeatTimer = setInterval(() => {
        if (astrbotSocket?.readyState === WebSocket.OPEN) {
            astrbotSocket.ping();
        }
    }, 25_000);
}
function stopAstrBotHeartbeat() {
    if (astrbotHeartbeatTimer) {
        clearInterval(astrbotHeartbeatTimer);
        astrbotHeartbeatTimer = null;
    }
}
function rememberEvent(event) {
    recentEvents.push({
        ...event,
        received_at: Date.now()
    });
    if (recentEvents.length > 120) {
        recentEvents.splice(0, recentEvents.length - 120);
    }
}
function broadcastToApps(payload, exceptClientId) {
    for (const client of appClients.values()) {
        if (client.id === exceptClientId || !client.authenticated) {
            continue;
        }
        sendJson(client.socket, payload);
    }
}
function sendJson(socket, payload) {
    if (socket.readyState !== WebSocket.OPEN) {
        return;
    }
    socket.send(JSON.stringify(payload));
}
function parseJsonMessage(data) {
    try {
        const raw = Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : Buffer.isBuffer(data)
                ? data.toString("utf8")
                : Buffer.from(data).toString("utf8");
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
function sendHttpJson(response, statusCode, payload) {
    response.writeHead(statusCode, {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*"
    });
    response.end(JSON.stringify(payload));
}
function readPort(value, fallback) {
    if (!value) {
        return fallback;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function readString(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
}
function readNumber(value, fallback = 0) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }
    return fallback;
}
function readEnv(...keys) {
    for (const key of keys) {
        const value = process.env[key]?.trim();
        if (value) {
            return value;
        }
    }
    return undefined;
}
function readObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function makeId(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
function safeId(value) {
    const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 42);
    return cleaned || crypto.randomUUID().replace(/-/g, "");
}
function safeAudioFileName(value, mimeType) {
    const cleaned = value.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 80);
    if (cleaned && /\.[a-z0-9]{2,5}$/i.test(cleaned)) {
        return cleaned;
    }
    const extension = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") || mimeType.includes("m4a") ? "m4a" : "webm";
    return `${safeId(cleaned || crypto.randomUUID())}.${extension}`;
}
function latestActiveCallId() {
    let latest = null;
    for (const call of activeCalls.values()) {
        if (!latest || call.startedAt > latest.startedAt) {
            latest = call;
        }
    }
    return latest?.callId ?? "";
}
function normalizeVoiceReplyMode(value) {
    return value === "backend_model" ? "backend_model" : "astrbot";
}
function normalizeAsrProvider(value) {
    return value === "openai_transcriptions" ? "openai_transcriptions" : "openai_chat_audio";
}
function normalizeAudioFormat(value) {
    return value === "mp3" ? "mp3" : "wav";
}
function normalizeBaseUrl(value) {
    return value.trim().replace(/\/+$/, "");
}
function geminiModelPath() {
    const model = config.geminiModel.trim() || "gemini-2.5-flash";
    if (model.startsWith("models/") || model.startsWith("tunedModels/")) {
        return model;
    }
    return `models/${encodeURIComponent(model)}`;
}
function resolvePublicBaseUrl() {
    if (config.publicBaseUrl) {
        return config.publicBaseUrl;
    }
    const client = [...appClients.values()].find((item) => item.authenticated && item.publicBaseUrl);
    return client?.publicBaseUrl ?? `http://127.0.0.1:${config.port}`;
}
function publicBaseUrlFromRequest(request) {
    const forwardedProto = firstHeader(request, "x-forwarded-proto");
    const forwardedHost = firstHeader(request, "x-forwarded-host");
    const protocol = forwardedProto ?? ((request.socket.encrypted ? "https" : "http"));
    const host = forwardedHost ?? firstHeader(request, "host") ?? `127.0.0.1:${config.port}`;
    return `${protocol}://${host}`;
}
function firstHeader(request, name) {
    const value = request.headers[name];
    if (Array.isArray(value)) {
        return value[0];
    }
    return value;
}
function loadDotEnv() {
    const envPath = path.join(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) {
        return;
    }
    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }
        const equalsAt = trimmed.indexOf("=");
        if (equalsAt <= 0) {
            continue;
        }
        const key = trimmed.slice(0, equalsAt).trim();
        let value = trimmed.slice(equalsAt + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        else {
            value = value.replace(/\s+#.*$/, "").trim();
        }
        if (!(key in process.env)) {
            process.env[key] = value;
        }
    }
}
function log(message) {
    console.log(`[voice-bridge] ${message}`);
}
async function shutdown(signal) {
    shuttingDown = true;
    log(`Stopping by ${signal}`);
    if (astrbotReconnectTimer) {
        clearTimeout(astrbotReconnectTimer);
        astrbotReconnectTimer = null;
    }
    stopAstrBotHeartbeat();
    astrbotSocket?.close();
    for (const client of appClients.values()) {
        client.socket.close();
    }
    await new Promise((resolve) => {
        appServer.close(() => resolve());
    });
    await new Promise((resolve) => {
        httpServer.close(() => resolve());
    });
    process.exit(0);
}
process.on("SIGINT", () => {
    void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
});
httpServer.listen(config.port, config.host, () => {
    log(`APP backend listening on ws://${config.host}:${config.port}/app`);
    log(`Health check: http://127.0.0.1:${config.port}/health`);
    log(config.mimoApiKey ? `MiMo TTS ready: ${config.mimoTtsModel}/${config.mimoTtsVoice}` : "MiMo TTS disabled: missing MIMO_API_KEY");
    log(`Voice reply mode: ${config.voiceReplyMode}`);
    log(config.asrApiKey
        ? `ASR ready: ${config.asrModel} (${config.asrProvider}, ${config.asrBaseUrl})`
        : "ASR disabled: missing ASR_API_KEY / OPENAI_API_KEY");
    log(config.geminiApiKey
        ? `Backend model ready: ${config.geminiModel} (${config.geminiApiFormat}, ${config.geminiBaseUrl})`
        : "Backend model disabled: missing GEMINI_API_KEY / OPENAI_API_KEY");
    connectAstrBot();
});
