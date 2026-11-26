# 用本地 MCP 调用两个 Skill

适合能启动本地 MCP stdio 进程、但没有通用终端工具的 AI 客户端。程序与素材在执行机器上，原帧和选定音频片段会返回给当前客户端及其模型。选择允许处理这些素材的宿主。仅接受远程 URL 的客户端需要另有它支持的本地连接机制。

## 连接

在电脑上准备一个专用工作目录，和本机账号状态分开。配置客户端启动 Node.js 22+。下面的 JSON 是常见的配置示例，换成实际绝对路径。制稿还需要可从该进程找到的 Python 3.9+、Pillow、FFmpeg、ffprobe。图形客户端的 PATH 可能与终端不同，可在启动环境补全，或用 `--python` 指向已装 Pillow 的 Python。

```json
{
  "mcpServers": {
    "xhs-notes": {
      "command": "node",
      "args": [
        "/absolute/path/xhs-note-skills/bridge/server.mjs",
        "--workspace", "/absolute/path/note-workspace",
        "--account", "我的创作账号",
        "--nickname", "创作者中心显示的完整昵称"
      ]
    }
  }
}
```

先建立工作区的根目录。用稳定的本机账号键替换「我的创作账号」，用小红书创作者中心的实际昵称替换最后一项。只打算在本地制稿时，可以省略这两组选项。运行 `node bridge/server.mjs --help` 可查看启动参数。

将原片放到工作区的 `inputs/`。桥接器初次运行会建立 `inputs/`、`jobs/`、`notes/`。把已有图文稿整个放入 `notes/稿件名/` 也可以直接验包。仅在受信任的本地专用目录运行，服务存续期间避免其他进程同时改动输入、稿件或创建链接。全程可沿用同一工作区与同一发布账本。

## 给 AI 的操作顺序

1. `list_inputs` 列出待处理文件和已有稿件；`acquire_video({file:"demo.mp4"})` 取得来源 ID。有权使用链接时调用 `acquire_video({url})`，通过临时的匿名 Chrome 尝试公开播放器。
2. `prepare_frames({sourceId, audio:true})` 返回帧集 ID、帧号、时间、可听音轨秒数以及 `planTemplate`。可用 `at:[1.2,5.0]` 在特定时间重新取帧。
3. `view_image({sourceId,frameSet,frame:"f01"})` 返回实际原图。需核对口述时用 `listen_clip({sourceId,frameSet,start:1,end:5})` 取实际音频，每段最多 20 秒。宿主必须支持 MCP image 才能在聊天中看原帧，支持 MCP audio 才能听音段。仅能收文本时，把素材交给可看图/听音的本地工具或让拥有者提供经核对的转录。桥接器提供证据，实际内容判断由宿主作出。
4. 复制当前帧集模板填上标题、正文和图片规划，按制稿 Skill 核对证据。用 `build_note({sourceId,frameSet,plan})` 写到 `notes/`，返回稿件名和指纹。开成品图 `view_image({note,image:"cover.jpg"})`，核对图注、图片顺序和可读性。
5. `check_note({note})` 纯本地返回标题、正文、配图顺序和指纹。可以在这里交付或交给另一台具备发布权限的 AI。
6. 要看网页效果时，运行 `npm ci --prefix skills/xhs-publish-note` 安装浏览器依赖。首次使用官网，调用 `login({account,nickname,confirmLogin:true})`，账号持有人在本机 Chrome 扫码。用户同意上传本篇预览后，调用 `preview_note({note,account,nickname,confirmPreview:true})`。这会把图文上传到创作者中心，可能形成草稿。完成后应看到 `status:"previewed"`、`published:false` 和本次官网手机预览图；手机图缺失时尝试返回整页图。若两张图均不可用，结果会说明。MCP 关闭窗口后返回结果；需要保留网页自行翻页时，从仓库根目录运行 `node skills/xhs-publish-note/cli.mjs preview "稿件目录" --account "本机账号键" --keep-open`。

官网处理图片可能耗时数分钟。如果 MCP 客户端允许设置工具调用超时，请留出足够时间。超时后先在本地核对该次预览记录，再决定是否重新上传；原片和图文稿可以继续复用。

## 链接解析与发布授权

- 默认链接路径只尝试读取正常匿名播放的单条作品。需要本机 Google Chrome、ffprobe 和公开播放器自己的 `playwright-core`。在 `skills/xhs-video-to-note/browser/` 运行 `npm ci` 安装锁定版本；如 npm 缓存已包含该版本，可离线执行 `npm ci --offline`。确认视频身份、尺寸、时长和文件完整性后才开始本地制稿。链接仅通过私有临时文件传给公开播放器，MCP 调用消息由所选宿主处理。匿名访问受限或未能核实原片时，提供 `inputs/` 中有权使用的本地视频即可继续。
- 如要改走 TikHub，执行者须允许本次付费详情查询，在私有环境中设置 `TIKHUB_API_KEY`，并在服务启动参数中加 `--allow-paid`。宿主核实用户批准后调用 `acquire_video({url,confirmPaid:true})`。密钥由设备持有人管理。复用同一输入和工作区可从原下载回执继续。
- 账号操作需在启动参数中同时设 `--account 本机账号键 --nickname 官网昵称`。需要官网窗口时，先按发布 Skill 安装浏览器依赖。用户要求登录并在设备旁扫码时，调用 `login({account,nickname,confirmLogin:true})`。
- 正式投稿还需服务启动者加 `--allow-publish`。给用户看当前标题、正文、图片和目标账号，获得覆盖此操作的明确授权后再调用 `publish_note({note,account,nickname,fingerprint,confirmSubmit:true})`。指纹应与本次授权版本相同。宿主可以开启这些付费/发布工具的逐次审批。启动参数和工具布尔值控制执行权限；用户对稿件、目标和费用的真实意愿由宿主核对。
- 用 `lookup_note({note,account,nickname})` 查询原提交，按官网实际结果记录。已提交但断线时继续查原稿。

## 运行协议与测试

桥接使用 2025-06-18 版 MCP、UTF-8 换行分隔 JSON-RPC 2.0、本地 stdio、`tools/list` 和 `tools/call`。协商其他版本时返回所支持的协议版本；客户端须能接受该版本。有本机可执行配置的宿主也可直接使用两个 Skill 的 CLI。[MCP 初始化](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle) · [stdio 传输](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) · [工具结果](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

在源码目录运行 `node --test bridge/server.test.mjs`。测试在临时目录使用合成视听素材，覆盖真实 stdio 握手、文件访问范围、匿名播放器路由与原片绑定、默认关闭的付费和发布操作、音频与图像返回、完稿与独立验包。这些测试不调用 TikHub 或小红书账号。
