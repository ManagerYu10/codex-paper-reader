# 豆包 PDF 阅读插件模型路由审计

## 结论

截至 2026-08-29，**无法从已安装扩展或公开材料可靠确认豆包 PDF 阅读插件背后的固定基础模型版本**。本项目将其记录为：

```text
豆包浏览器插件 1.38.0（黑盒、动态路由、基础模型未披露）
```

## 本地静态检查

- 已安装扩展 ID：`dbjibobgilijgolhjdcbdebjhejelffo`。
- Manifest 版本：`1.38.0`。
- 打包代码包含 `/chat/completion`、`/alice/message/stream`、动态 `bot_id` 等产品路由。
- 可见默认助手 bot id，但没有发现可验证的 `Seed2.1-Pro`、`Seed2.1-Lite` 或其他固定模型 slug。

bot id 是产品智能体/路由标识，不等于基础模型版本。服务端可按账户、任务、负载或 A/B 实验改变实际模型，因此不能通过一次前端静态检查反推出底层模型。

## 公开材料能说明什么

- 字节跳动已发布 Seed2.1，并称相关能力进入豆包产品；这只能证明产品家族可能使用 Seed2.1 能力，不能证明 PDF 插件的每次请求固定路由到某一档模型。
- 豆包的模型说明和服务条款承认生成结果可能存在事实或数字不准确，但没有公开 PDF 插件的精确模型映射。

## 评测记录要求

产品轨道至少记录：插件版本、日期、PDF URL/哈希、完整输入输出、是否新会话和可见产品模式。只有响应元数据或官方接口明确返回模型 slug 时，才把结果归因到具体基础模型。

参考：

- [Seed2.1 官方发布说明](https://seed.bytedance.com/zh/blog/seed2-1-officially-released-advancing-ai-productivity)
- [豆包浏览器插件页面](https://www.doubao.com/browser-extension/landing)
- [豆包模型说明](https://www.doubao.com/legal/instructions)
- [豆包服务条款](https://www.doubao.com/legal/terms)
