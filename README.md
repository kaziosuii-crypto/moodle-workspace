# Moodle 编程工作区

把 Moodle 的 `mod/programming` 编程练习页改造成一个完整的工作区：左边题面、右边 CodeMirror 6 编辑器、下边用例与判题结果，旁边还有一个能读懂代码的 AI 辅导。

> 给零基础学 C 的人做作业用。装完在设置里填一次自己的 API Key 即可。

## 功能

- **CodeMirror 6 编辑器**：C 语法高亮、括号配对、自动补全、搜索替换、代码折叠
- **本地编译运行**：内置 Clang/LLVM 编译到 WASM，首次使用下载约 40 MB 并缓存本机，之后断网也能编译运行，全程不碰判题服务器
- **死循环不会卡死页面**：代码跑在可终止的 Worker 沙箱里，超过 6 秒强制中断并提示
- **严格按字节比较**：和 Moodle 判题器一样逐字节比对，末尾少一个换行符也判不通过，并在结果里用 `↵` 标出来
- **字符级差异对比**：不通过时直接指出从第几个字符开始不同，一眼看出是少了换行还是算错了
- **编译器报错人话化**：`expected ';' before '}'` 这类英文报错翻成中文，按行标在编辑器里，点行号直接跳过去
- **AI 辅导（流式输出）**：先讲思路，再给出逐行问题与修改建议，边生成边显示
- **AI 用例生成**：按题目和公开样例生成边界用例，生成后逐个可编辑
- **一键导出**：把全部草稿、用例和 AI 分析导成 JSON 或 Markdown

## 安装

1. 装 [Tampermonkey](https://www.tampermonkey.net/)
2. 打开下面任意一条安装链接，Tampermonkey 会弹出安装页
3. 点「安装」

| 线路 | 安装地址 |
|---|---|
| Gitee（国内快） | `https://gitee.com/USER/moodle-workspace/raw/master/code.user.js` |
| GitHub + jsDelivr | `https://cdn.jsdelivr.net/gh/USER/moodle-workspace@main/code.user.js` |

两条内容完全一致，装任意一条就行。

## 配置 API Key

脚本**不内置任何密钥**。第一次使用 AI 功能会弹出设置窗口，去 [硅基流动控制台](https://cloud.siliconflow.cn/account/ak) 建一个 Key 粘进去，点「测试连接」验证。

密钥只写进这台浏览器的 localStorage，**脚本更新后依然保留**，不会上传到任何地方。

## 自动更新

脚本头部带 `@version` / `@updateURL` / `@downloadURL`。Tampermonkey 默认每 24 小时检查一次，发现版本号变大就自动更新；也可以在其面板里点「检查更新」。

- `@updateURL` 指向 **Gitee raw**：没有 CDN 缓存，新版本立刻可见
- `@downloadURL` 指向 **jsDelivr**：国内下载稳定

发布新版本只要改版本号再推上去，已安装的用户下次检查时就会自动更新。

## 自己发版

```powershell
# 1. 填上自己的账号（repo.config.mjs，里面不含任何密钥）
#    REPO.github.user / REPO.gitee.user

# 2. 改版本号 + 重新构建
node release.mjs patch      # 或 minor / major

# 3. 推到两个平台
$env:GITHUB_TOKEN = "ghp_..."
$env:GITEE_TOKEN  = "..."
node publish.mjs
```

Token 只从环境变量读取，以一次性 push URL 的形式传给 git，不会写进 `.git/config`。

## 本地开发

```bash
npm install
node build.mjs          # 产出 code.user.js
node --test tests.mjs   # 单元测试
```

| 文件 | 作用 |
|---|---|
| `workspace.mjs` / `workspace.css` | 界面与全部交互 |
| `adapter.mjs` | 解析 Moodle 页面 |
| `ai.mjs` / `ai-key.mjs` / `ai-config.mjs` | 模型调用、密钥存储、公共配置 |
| `tutor.mjs` | AI 辅导的系统提示词 |
| `diagnostics.mjs` | 编译器报错解析、输出字符级 diff |
| `sandbox.mjs` | 可终止的执行沙箱 |
| `repo.config.mjs` | 发布目标（build 据此写入更新地址） |

## 说明

- 只作用于自己声明的 `@match` 页面，不修改 Moodle 服务端的任何行为
- 判题仍然走 Moodle 官方提交，脚本只负责把结果显示得更清楚
- **「运行」完全在本机浏览器里完成**，代码不会因此离开你的电脑；只有你主动点 AI 功能时，题干与代码才会发给硅基流动

## 许可

MIT
