# -*- coding: utf-8 -*-
"""单章体检报告（每写完一章就跑一次）

输出：
  · 字数 / 句段分布（对照西幻章级档）
  · 标点密度（对照真人 p25 下限 + 句号 p75）
  · 说族占比 / 明喻 / 承接词 / 环境段
  · 修辞种类 / 单字词占比 / 情绪词密度（V0.39 W8~W11）
  · 门1 语感分
用法：python 03_评分与校准/chapter_report.py "path/to/第01章.md"
"""
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdout.reconfigure(encoding='utf-8')
from _metrics import probe, norm_len, POS_WORDS, NEG_WORDS  # noqa: E402
import lint_check as L  # noqa: E402
import ai_flavor_score as A  # noqa: E402
import jieba.posseg as pseg  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
BASE = json.load(io.open(os.path.join(ROOT, '08_统计基线', '题材基线_章级_133本.json'),
                         encoding='utf-8'))
BAND = BASE['genres']['西幻/异世界']

RHE = {
    '明喻': re.compile(r'(像|仿佛|如同|似的|宛如|好像|犹如|恰似|好似)'),
    '暗喻': re.compile(r'(?:是|成了|变成|化为)[^，。！？]{0,12}(?:的|一样)'),
    '反问': re.compile(r'(难道|岂|何尝|何必|怎么会|怎能)'),
    '设问': re.compile(r'[？?]'),
    '夸张': re.compile(r'(无比|极(?:其|为)|要命|得要死|千|万|成百上千|震天|惊天|铺天盖地)'),
    '对偶': re.compile(r'[^，。！？]{2,6}[，,][^，。！？]{2,6}[，,][^，。！？]{2,6}[。！？]'),
    '排比': re.compile(r'[^，。！？\n]{1,10}[，,][^，。！？\n]{1,10}[，,][^，。！？\n]{1,10}[，,]'),
    '拟人': re.compile(r'(?:风|雨|雪|云|月|光|火|树|草|石头|骨头|影子|声音)[^，。]{0,6}'
                      r'(?:笑|哭|喘|睡|醒|记得|忘了|愿意|不肯|认得|听着|看着|等着)'),
}


def band_line(label, key, val, nd=1, unit=''):
    b = BAND.get(key)
    if not b:
        print('  %-14s %s%s' % (label, val, unit))
        return
    lo, hi = b['min'], b['max']
    flag = 'OK'
    if val < lo:
        flag = '低'
    elif val > hi:
        flag = '高'
    print('  %-14s %8.*f%s   档 %.*f~%.*f   目标 %.*f~%.*f   %s' % (
        label, nd, val, unit, nd, lo, nd, hi, nd, b['p25'], nd, b['p75'], flag))


def main():
    p = sys.argv[1]
    t = io.open(p, encoding='utf-8').read()
    n = norm_len(t)
    r = probe(t, os.path.basename(p))
    print('=' * 84)
    print('单章体检 · %s（%d 非空白字符）' % (os.path.basename(p), n))
    print('=' * 84)

    print('\n【结构】')
    band_line('均句长', 'smean', r['smean'])
    band_line('句长sd', 'ssd', r['ssd'])
    band_line('均段长', 'pmean', r['pmean'])
    band_line('段长sd', 'psd', r['psd'])
    band_line('对白段%', 'dlg_pct', r['dlg_pct'], 0)
    band_line('环境段%严格', 'env2_pct', r['env2_pct'], 0)

    print('\n【用词】')
    band_line('说族/千字', 'said_kilo', r['said_kilo'], 2)
    band_line('明喻/千字', 'simile_kilo', r['simile_kilo'], 2)
    band_line('承接词自然/千', 'conn_nat_kilo', r['conn_nat_kilo'], 2)
    band_line('句首重复率', 'head_rep', r['head_rep'], 3)

    print('\n【情感】')
    band_line('情感极性sd', 'pol_sd', r['pol_sd'], 3)
    band_line('情感转折/千', 'pol_turns_kilo', r['pol_turns_kilo'], 2)
    band_line('正向句%', 'pol_pos_pct', r['pol_pos_pct'], 0)
    band_line('负向句%', 'pol_neg_pct', r['pol_neg_pct'], 0)

    print('\n【标点】（每千字；下限＝真人 p25，V0.39 只报警）')
    k = lambda c: 1000.0 * c / n
    punct = [('句号。', t.count('。'), None, BAND.get('max')),
             ('逗号，', t.count('，'), None, None),
             ('问号？', t.count('？'), 2.3, None),
             ('叹号！', t.count('！'), 1.5, None),
             ('省略号……', len(re.findall('……', t)), 0.4, None),
             ('顿号、', t.count('、'), 0.7, None),
             ('引号“', t.count('“'), None, None)]
    for lab, c, lo, _ in punct:
        d = k(c)
        flag = ''
        if lo is not None and d < lo:
            flag = ' ← 低于下限 %.1f' % lo
        print('  %-12s %7.2f%s' % (lab, d, flag))
    print('  句号档 p25~p75: 25.6~33.4（越高＝句末标点越单一）')

    print('\n【V0.39 语言表层】')
    s_n, a_n = len(L.SAID_VERB.findall(t)), len(L.ALL_VERB.findall(t))
    ratio = 100.0 * s_n / max(a_n, 1)
    print('  说族占比 %d/%d = %.1f%%（上限 46%%）%s' % (
        s_n, a_n, ratio, '' if ratio <= 46 else '  ← 超限'))
    verbs = [w.word for w in pseg.cut(t)
             if w.flag.startswith('v') and w.word not in L.STOP_VERBS]
    nouns = [w.word for w in pseg.cut(t) if w.flag.startswith('n')]
    v1 = 100.0 * len([w for w in verbs if len(w) == 1]) / max(len(verbs), 1)
    n1 = 100.0 * len([w for w in nouns if len(w) == 1]) / max(len(nouns), 1)
    print('  单字实义动词 %.1f%%（真人 16.8%%；**已退出机器门**，仅供恶人编辑参考）' % v1)
    print('  单字名词占比 %.1f%%（真人 12.9%%；**已退出机器门**，仅供参考）' % n1)
    emo = sum(t.count(w) for w in POS_WORDS + NEG_WORDS)
    print('  情绪词密度 %.2f/千字（真人 17.98；**已退出机器门**，仅供参考）' % k(emo))
    kinds = {kk: len(vv.findall(t)) for kk, vv in RHE.items()}
    hit = [kk for kk, vv in kinds.items() if vv > 0]
    print('  修辞种类 %d 种（目标 ≥6）：%s' % (
        len(hit), '、'.join('%s%d' % (kk, kinds[kk]) for kk in RHE if kinds[kk])))
    for need in ('设问', '反问', '夸张', '拟人'):
        if kinds.get(need, 0) == 0:
            print('    ← 缺「%s」' % need)
    print('  明喻 %d 处（≤2.2/千字 → ≤%.0f 处）；排比 %d 处；对偶 %d 处' % (
        kinds['明喻'], 2.2 * n / 1000, kinds['排比'], kinds['对偶']))
    print('  三连排比（门1 判据）%d 处' % len(A.SANLIAN.findall(t)))

    sc = A.score_text(t)
    print('\n【门1 语感】%d 分（上限 37）%s' % (
        sc['score'], '' if sc['score'] <= 37 else '  ← 超限'))
    if sc['violations']:
        for v in sc['violations']:
            print('  · %s：%s' % (v['rule'], v['advice'][:70]))


if __name__ == '__main__':
    main()
