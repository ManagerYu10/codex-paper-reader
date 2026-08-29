# 论文导读事实幻觉评测方法

## 1. 评测对象

评测的是“给定完整论文后生成结构化中文导读”的端到端任务，不是开放域知识问答。论文原文是唯一允许的事实来源。

分两条轨道：

- **Controlled Text Track：** 所有 API 模型接收同一份带页码标记的 PDF 抽取文本和同一产品 Prompt，用于隔离语言模型差异。
- **Product Track：** 直接记录 GPT 阅读器与豆包浏览器插件的真实输出，包含各自 PDF 解析、路由、Prompt 和模型的综合效果。

产品轨道不能直接归因到某个基础模型，除非响应元数据或官方文档明确披露了模型版本。

## 2. 核心单位：原子事实

沿用 FActScore 的思路，把一份导读拆成最小可独立判真的声明。复合句和多个数字关系需要拆开。纯标题、修辞、建议以及明确标记为直觉解释的类比不计入事实声明。

每条声明相对论文原文标记为：

- `supported`：论文明确支持。
- `contradicted`：论文明确给出冲突信息。
- `not_in_source`：论文没有依据，属于凭空补充。
- `ambiguous`：PDF 抽取损坏、必须依赖未解析图像，或证据不足以可靠判断。

`ambiguous` 不进入自动幻觉率分母，而进入人工复核队列。

## 3. 错误类型

参考 FRANK 的细粒度思想，并针对论文导读扩充：

- `entity`：模型名、数据集名、模块或对象错误。
- `relation`：谁使用/提出/优于谁等关系错误。
- `number`：样本数、分数、比例、训练参数等数字或单位错误。
- `circumstance`：时间、位置、实验条件、数据划分等错误。
- `discourse`：跨句指代、因果、比较范围或结论强度错误。
- `out_of_source`：论文中不存在的模块、实验、动机或结论。
- `citation_mismatch`：引用章节、页码、图表存在但不支持对应声明。

## 4. 指标

| 指标 | 定义 | 越好 |
|---|---|---:|
| Atomic factual precision | supported / 所有可判定原子事实 | 高 |
| Hallucination rate | (contradicted + not_in_source) / 所有可判定原子事实 | 低 |
| Major hallucination rate | 影响方法主线或核心结论的幻觉 / 所有可判定原子事实 | 低 |
| Numeric error rate | 错误数字声明 / 可判定数字声明 | 低 |
| Unsupported invention rate | not_in_source / 所有可判定原子事实 | 低 |
| Citation precision | 真正支持声明的引用 / 所有带引用声明 | 高 |
| Key-fact recall | 正确覆盖的人工关键事实 / 全部关键事实 | 高 |
| Manual-review count | 模糊声明 + 重大错误候选 | 低 |

不把“写得短所以少犯错”直接视为最好，因此同时报告关键事实召回率。

## 5. 判分流程

1. 固定 Prompt、论文版本、抽取文本哈希、模型 slug、推理档位和运行时间。
2. 使用独立模型把候选导读拆成原子事实，不接触论文，以免在拆分阶段替候选修正内容。
3. 判分模型查看论文、原子事实和人工关键事实，返回标签、短证据、页码及错误类型。
4. 脚本计算指标，所有 `ambiguous` 与重大错误进入人工复核。
5. 正式报告使用两个不同系列的判分模型，报告逐条标签一致率；所有分歧、所有重大错误及全部数字错误必须人工复核。
6. 当人工复核尚未穷尽全部声明时，只报告“人工确认的错误下界”，不把机器裁判的单一分数称为真实幻觉率。

## 6. 已知限制

- LLM-as-a-judge 不是事实真值，尤其容易受长文检索、表格抽取和候选措辞影响。
- PDF 纯文本轨道会丢失部分图表视觉信息；这些项目应标记为 `ambiguous`，不能强判错误。
- 同一产品可能做动态模型路由和 A/B 实验，因此豆包结果必须记录插件版本、日期和会话输出，不能只写“豆包某模型”。
- 通用新闻摘要 benchmark 不能直接代表科学论文；本项目用其方法论设计自有论文样本，并保留人工证据。

## 7. 方法依据

- [FActScore](https://aclanthology.org/2023.emnlp-main.741/)：原子事实拆分与事实精度。
- [FRANK](https://arxiv.org/abs/2104.13346)：细粒度事实错误类型。
- [QAFactEval](https://aclanthology.org/2022.naacl-main.187/)：QA 与蕴含信号互补。
- [Long-form factuality / SAFE](https://arxiv.org/abs/2403.18802)：长答案逐事实核验。
- [Stress Testing Factual Consistency Metrics for Long-Document Summarization](https://aclanthology.org/2026.acl-long.1472/)：短文指标迁移到长文时的稳定性限制。
