# -*- coding: utf-8 -*-
"""add_when_to_read.py — 给 references 每份文档加「何时读 ＋ 适用题材档」一行（S4，作者已批）

幂等：已有「何时读」行则跳过。
"""
import io
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

REF = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'skills_V0.3', 'references')

WHEN = {
    '00_门速查卡.md': ('任何阶段（日常唯一入口，替代读规则书全文）', '全题材'),
    '01_规则书_V0.40.md': ('改规则/加判据时（日常只读 00_门速查卡）', '全题材'),
    '02_流水线总纲.md': ('开新书 / 改流程时', '全题材'),
    '03_提示词包_三阶段.md': ('每章生成前（beat/规划表/生成/恶人编辑提示词）', '全题材'),
    '04_病灶库.md': ('每章生成前（注入包已含 Top10＋最近10）', '全题材'),
    '05_水文技法库.md': ('写"不推进但要活"的段落时', '全题材（商战/种田题材慎用）'),
    '06_风格锚点池.md': ('需要仿写腔调时', '全题材'),
    '07_评委提名验证.md': ('做 AI 提名 / 设计盲评时', '全题材'),
    '08_设定表使用说明.md': ('开新书填 12 张表时', '全题材'),
    '09_真人审查表.md': ('交付作者审查时', '全题材'),
    '10_AI审查_提示词包.md': ('外部 AI 审查时', '全题材'),
    '11_恶人编辑_子代理审核包.md': ('恶人编辑阶段（子代理暂停中，执行方式由作者定）', '全题材'),
    '12_开头技法_真人语料.md': ('写第 1 章开头 / 定首句时', '全题材'),
    '13_提案_语域限定.md': ('讨论方言/语域时（**待作者裁定**）', '都市/历史/年代相关'),
    '14_提案_规划表中间件.md': ('讨论生成模式时（**待作者裁定**）', '全题材'),
    '15_语域卡_分档.md': ('生成前定档 + 注入包取该档基线', '**按档读**：西幻/仙侠/都市/历史/同人/灵异/武侠/废土'),
    '16_文学语料_文风基线.md': ('对齐文学腔 / 欧化时（资料层，不注入）', '资料层'),
    '17_提案_门12与句尾复用_已采纳.md': ('追溯门12 / 门7E 的由来时（留档）', '全题材'),
}


def main():
    n = 0
    for fn, (when, scope) in WHEN.items():
        p = os.path.join(REF, fn)
        if not os.path.exists(p):
            print(f'  跳过（不存在）：{fn}')
            continue
        t = io.open(p, encoding='utf-8').read()
        if '何时读：' in t:
            print(f'  已有标注，跳过：{fn}')
            continue
        lines = t.split('\n')
        # 插到第一个非空标题行之后
        idx = 0
        for i, ln in enumerate(lines[:6]):
            if ln.strip().startswith('#'):
                idx = i
                break
        tag = f'\n> 何时读：**{when}**｜适用题材档：**{scope}**\n'
        lines.insert(idx + 1, tag)
        io.open(p, 'w', encoding='utf-8').write('\n'.join(lines))
        n += 1
        print(f'  ✅ {fn}')
    print(f'\n共标注 {n} 份。')


if __name__ == '__main__':
    main()
