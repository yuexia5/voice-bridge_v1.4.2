# 琉璃来电 APP 后端桥接服务

这个服务连接两边：

- 上游：AstrBot 插件 `astrbot_plugin_voice_call_bridge`
- 下游：安卓 APP `琉璃来电`

## 当前默认架构

新版默认是 `VOICE_REPLY_MODE=astrbot`：

1. APP 录音并上传 `audio/wav` base64。
2. 后端用 ASR 把语音转成文字。
3. 后端把文字发给 AstrBot 插件的 `app.user_text`。
4. AstrBot 用当前会话的模型、人格、记忆和工具链生成回复。
5. 后端用 MiMo TTS 合成语音，推给 APP 播放。

这样电话里的 AI 就是 AstrBot 当前会话里的 AI。比如 QQ 那边当前用 Claude，电话里默认也交给这个 AstrBot 会话回复，并且有机会调用 AstrBot 工具。

如果你想“QQ 用 Claude，电话切到 Gemini”，可以改成：

```bash
VOICE_REPLY_MODE=backend_model
```

这个模式会让后端直接把音频交给 OpenAI/Gemini 兼容多模态模型生成回复。它会带上 AstrBot 发来的上下文快照，也会在挂断后写回总结，但中途不保证能调用 AstrBot 工具。

如果 `VOICE_REPLY_MODE=astrbot` 下仍然看到 “Gemini / Google 训练” 这类回复，优先看后端日志里的 `ASR transcript accepted`。这种情况通常是 ASR 模型没有按“只转写”执行，而是直接回答了音频。新版会拦截明显的模型自我介绍，并提示你更换 ASR 模型或改用 `ASR_PROVIDER=openai_transcriptions`。

## 常用地址

- Android 模拟器连接本机：`ws://10.0.2.2:8789/app`
- 手机直连 Ubuntu 服务器：`ws://服务器公网IP:8789/app`
- 手机连接 Nginx HTTPS 反代：`wss://voice.example.com/app`
- AstrBot 插件：`ws://127.0.0.1:8765`
- 健康检查：`http://127.0.0.1:8789/health`
- TTS 音频：`http://服务器:8789/audio/xxx.wav`

## 启动

```bash
npm install
npm run build
npm run start
```

开发环境可以用：

```powershell
npm.cmd run dev
```

## 环境变量

基础连接：

- `HOST`：服务监听地址，默认 `0.0.0.0`
- `PORT`：服务端口，默认 `8789`
- `ASTRBOT_BRIDGE_URL`：AstrBot 插件 WebSocket 地址，默认 `ws://127.0.0.1:8765`
- `ASTRBOT_BRIDGE_TOKEN`：AstrBot 插件鉴权 token
- `APP_TOKEN`：APP 连接鉴权 token，公网部署建议一定设置
- `PUBLIC_BASE_URL`：APP 访问 TTS 音频文件的公网地址

回复模式：

- `VOICE_REPLY_MODE=astrbot`：默认。ASR 转文字后交给 AstrBot 回复，可使用 AstrBot 工具
- `VOICE_REPLY_MODE=backend_model`：后端模型直接回复，适合电话切 Gemini，但工具能力弱

ASR 配置：

- `ASR_PROVIDER=openai_chat_audio`：默认，使用 `/chat/completions` + `input_audio`
- `ASR_PROVIDER=openai_transcriptions`：使用 `/audio/transcriptions`
- `ASR_BASE_URL`：OpenAI 兼容站 `/v1` 地址
- `ASR_API_KEY`：ASR 接口 key
- `ASR_MODEL`：ASR 模型名
- `ASR_LANGUAGE`：默认 `zh`

MiMo TTS：

- `MIMO_API_KEY`：小米 MiMo API Key
- `MIMO_BASE_URL`：默认 `https://api.xiaomimimo.com/v1`
- `MIMO_TTS_MODEL`：默认 `mimo-v2.5-tts`
- `MIMO_TTS_VOICE`：默认 `Chloe`
- `MIMO_TTS_FORMAT`：默认 `wav`
- `MIMO_TTS_STYLE`：声音风格提示词

后端模型模式：

- `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`：第三方 OpenAI 兼容站配置
- 也兼容 `GEMINI_API_KEY` / `GEMINI_BASE_URL` / `GEMINI_MODEL`
- `GEMINI_API_FORMAT=openai`：第三方站通常用这个
- `GEMINI_OPENAI_RESPONSE_FORMAT=none`：不确定兼容性时保持 `none`
- 在 `VOICE_REPLY_MODE=astrbot` 时，这组配置不会用于逐轮回复；只会用于通话结束后的 AI 总结增强。总结提示词会要求不要补充 Gemini、Google、OpenAI 等模型身份。

限制：

- `VOICE_MAX_AUDIO_SECONDS`：APP 单段录音最长秒数，默认 `0`，表示不限制。公网部署时如果担心请求体过大，可以改成 `60`。

## Ubuntu 直连测试

```bash
cd /opt/liuli-voice-call
npm install
npm run build

export HOST=0.0.0.0
export PORT=8789
export ASTRBOT_BRIDGE_URL=ws://127.0.0.1:8765
export ASTRBOT_BRIDGE_TOKEN=插件里的token
export APP_TOKEN=自己生成一个长一点的token
export PUBLIC_BASE_URL=http://服务器公网IP:8789

export VOICE_REPLY_MODE=astrbot
export ASR_PROVIDER=openai_chat_audio
export ASR_API_KEY=第三方站key
export ASR_BASE_URL=https://第三方站/v1
export ASR_MODEL=gemini-2.5-flash

export MIMO_API_KEY=小米MiMo_API_KEY
export MIMO_TTS_VOICE=Chloe

npm run start
```

服务器安全组或防火墙需要放行 `8789`。APP 里填：

```text
ws://服务器公网IP:8789/app
```

## Nginx + HTTPS

正式使用更推荐反代：

```bash
export HOST=127.0.0.1
export PORT=8789
```

然后用 `deploy/nginx-voice-bridge.conf.example` 反代，APP 里填：

```text
wss://你的域名/app
```

## 联调顺序

1. 在 AstrBot 里启用 `astrbot_plugin_voice_call_bridge` 插件，确认监听 `ws://127.0.0.1:8765`。
2. 保持插件配置 token 和这里的 `ASTRBOT_BRIDGE_TOKEN` 一致。
3. 启动本服务，日志里应出现 `AstrBot bridge ready`。
4. APP 设置页填后端地址和 `APP_TOKEN`，连接后应显示已连接。
5. 让 bot 调用 `start_voice_call`，APP 弹出来电。
6. 接听后录音发送，后端日志应显示 ASR 和转发给 AstrBot；APP 收到 AstrBot 回复文本和 MiMo TTS 音频。
