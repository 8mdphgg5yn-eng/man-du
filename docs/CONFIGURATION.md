# 模型与诊断配置

日常使用推荐 `node start-deepseek.mjs`，在本机页面输入密钥。该入口固定使用 DeepSeek 官方地址，不启用开发诊断。

通用入口为 `node server.mjs`，启动前可在自己的终端配置环境变量：

| 变量 | 含义 |
| --- | --- |
| EASY_READER_PROVIDER | deepseek、ollama、chat-completions |
| EASY_READER_MODEL | 模型名；不自动选择、安装或下载模型 |
| EASY_READER_ENDPOINT | 完整接口地址；云端需 HTTPS，不允许地址内嵌凭证、查询参数或片段 |
| EASY_READER_API_KEY | 仅本机进程使用，不要写入源码、命令参数或共享文件 |
| EASY_READER_PORT | 监听端口，默认 8770 |

Ollama 默认 `http://127.0.0.1:11434/api/chat`。兼容接口需明确提供完整 Chat Completions 地址。不同服务的参数和能力并不一致，需要自行核验。环境变量仅在启动时读取；页面 DeepSeek 配置作用于当前服务内存。

`prompts-v2.json` 和 `reader-engine.mjs` 是可信本地规则与代码，新请求按快照读取；同一请求不混用版本。其余服务器代码改动仍需重启。HTTP 请求不能指定引擎文件或上传代码。文件损坏时停止该次解释，不静默回退。

只有开发者显式设置 `EASY_READER_TEST_DIAGNOSTICS=1` 后运行通用 `server.mjs` 才会开放 `/api/dev/complex-test`。该同源 POST 仅接受 `{id:"park"或"card",mode:"pipeline"或"review-good"或"review-bad",cloudConsent:true}`，不能添加任意原文或候选。

诊断会真实调用已配置模型并可能产生费用。测试仅限两条自编句子。完成后可对 `/api/dev/complex-test/disable` 发送同源 POST，关闭诊断而保留本机模型配置；该入口不能重新开启诊断。普通阅读接口不返回诊断报告。

接口资料：[DeepSeek](https://api-docs.deepseek.com/)、[Ollama Chat](https://docs.ollama.com/api/chat)、[Chat Completions](https://developers.openai.com/api/reference/resources/chat)。
