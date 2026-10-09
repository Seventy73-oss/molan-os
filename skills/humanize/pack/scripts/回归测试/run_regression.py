# -*- coding: utf-8 -*-
"""run_regression.py — 机器门回归测试（规则书 V0.35）

## 为什么必须有这个文件

作者裁定：**每次审查不是为了「让文章过线」，而是「优化规则」**；并且**新判据必须过回归测试**
（提案C 已获批准）。加了一条判据而不证明它「该报的报、不该报的不报」，等于没加
（历史病灶 023「门形同虚设」）。

本文件用**程序生成的人造稿 + 人造账本**验证判据的灵敏度与特异度：
  · 坏稿必须被打回，且打回理由必须命中预期的那一项；
  · 好稿必须放行（证明不是靠「凡是相似就报警」蒙对的）；
  · 豁免必须生效（首尾呼应/母题逐字回调不得被误伤）。

用法：
  python run_regression.py
退出码：0 全部通过；2 有断言失败。
"""
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
GATES = os.path.dirname(HERE)
PY = sys.executable or 'python'
HEADER_ROW = 3


def write_tables(path, sheets):
    """sheets = {表名: [表头列表, 行1, 行2, ...]}，表头写在第 3 行。空字典也能生成。"""
    from openpyxl import Workbook
    wb = Workbook()
    wb.remove(wb.active)
    if not sheets:
        wb.create_sheet('占位')
    for name, rows in sheets.items():
        ws = wb.create_sheet(name)
        for r, row in enumerate(rows, start=HEADER_ROW):
            for c, v in enumerate(row, start=1):
                ws.cell(row=r, column=c, value=v)
    wb.save(path)


def make_case(root, name, chapters, sheets, extra=None):
    d = os.path.join(root, name)
    os.makedirs(d)
    for fn, text in chapters.items():
        io.open(os.path.join(d, fn), 'w', encoding='utf-8').write(text)
    for fn, text in (extra or {}).items():
        io.open(os.path.join(d, fn), 'w', encoding='utf-8').write(text)
    tp = os.path.join(d, '设定表_测试.xlsx')
    write_tables(tp, sheets)
    return d, tp


BASE_SHEETS = {
    '道具表': [
        ['道具名', '别名', '首次出现章', '章号', '状态（在场/离场/损毁/封存/易主）', '持有者', '位置'],
        ['铜钥匙', '', '第1章', 1, '在场', '甲', '桌上'],
    ],
    '事件时间表': [
        ['章号', '绝对时间（第N天）', '时段', '事件（唯一名）', '在场人物', '涉及道具',
         '状态变更（道具在哪/谁持有）', '相对时间词→指代事件', '核对提示'],
        [1, '第1天', '夜', '开场事件', '甲', '铜钥匙', '', '明天→次日事件', ''],
        [2, '第2天', '晨', '次日事件', '甲', '', '', '昨天→开场事件', ''],
    ],
    '人物已知信息表': [
        ['人物', '获知章号', '获知内容', '关键词（机器核对用，分号分隔）',
         '信息来源（亲见/被告知/推断）', '可对谁讲', '不得越界（此章前不可提及）', '备注'],
        ['甲', '第2章', '甲在第2章才知道暗号', '暗号', '亲见', '无人', '', ''],
    ],
    '伏笔钩子台账': [
        ['编号', '类型', '内容（原文短语）', '埋设章', '回收章', '回收方式', '是否入白名单', '状态', '备注'],
        ['F01', '伏笔', '某条伏笔', '第9章', '第9章', '变奏', '否', '未回收', '占位，避免误豁免'],
    ],
}

CLEAN_CH1 = '铜钥匙在桌上。甲看了它一眼，没动。\n'
CLEAN_CH2 = '甲把铜钥匙收进袖子。他昨天见过这把钥匙。\n'

CASES = []


def add(name, gate, args_fn, chapters, sheets, expect_exit, expect_text, extra=None):
    CASES.append({'name': name, 'gate': gate, 'args': args_fn, 'chapters': chapters,
                  'sheets': sheets, 'expect_exit': expect_exit,
                  'expect_text': expect_text, 'extra': extra or {}})


# ── 门12 打回型判据 ─────────────────────────────────────────────
def ch12(d, tp):
    return ['--chapters', d, '--tables', tp]


def ch12_nopass(d, tp):
    return ch12(d, tp)


add('门12 C1 道具提前出现：道具登记首现第2章，第1章已出现',
    'consistency_check.py', ch12,
    {'第01章.md': '铜钥匙在桌上。\n', '第02章.md': '甲把铜钥匙收进袖子。\n'},
    {'道具表': [BASE_SHEETS['道具表'][0], ['铜钥匙', '', '第2章', 2, '在场', '甲', '袖子']],
     '事件时间表': BASE_SHEETS['事件时间表'],
     '人物已知信息表': BASE_SHEETS['人物已知信息表']},
    2, 'C1 道具提前出现')

add('门12 C2 道具状态互斥：第2章登记离场，正文仍出现',
    'consistency_check.py', ch12,
    {'第01章.md': '铜钥匙在桌上。\n', '第02章.md': '甲把铜钥匙收进袖子。\n'},
    {'道具表': [BASE_SHEETS['道具表'][0],
                ['铜钥匙', '', '第1章', 1, '在场', '甲', '桌上'],
                ['铜钥匙', '', '', 2, '离场', '—', '已交还']],
     '事件时间表': BASE_SHEETS['事件时间表'],
     '人物已知信息表': BASE_SHEETS['人物已知信息表']},
    2, 'C2 道具状态互斥')

add('门12 C4 时间锚错位：第2天说「昨天」却指向第1天之外的事件',
    'consistency_check.py', ch12,
    {'第01章.md': '甲看了一眼。\n', '第02章.md': '他昨天见过这把钥匙。\n'},
    {'道具表': BASE_SHEETS['道具表'],
     '事件时间表': [BASE_SHEETS['事件时间表'][0],
                    [1, '第1天', '夜', '开场事件', '甲', '', '', '明天→次日事件', ''],
                    [2, '第2天', '晨', '次日事件', '甲', '', '', '昨天→次日事件', '']],
     '人物已知信息表': BASE_SHEETS['人物已知信息表']},
    2, 'C4 时间锚错位')

add('门12 C4 未登记：正文出现「明天」但口径列没登记',
    'consistency_check.py', ch12,
    {'第01章.md': '甲看了它一眼，明天再说。\n', '第02章.md': '甲走了。\n'},
    {'道具表': BASE_SHEETS['道具表'],
     '事件时间表': [BASE_SHEETS['事件时间表'][0],
                    [1, '第1天', '夜', '开场事件', '甲', '', '', '', ''],
                    [2, '第2天', '晨', '次日事件', '甲', '', '', '', '']],
     '人物已知信息表': BASE_SHEETS['人物已知信息表']},
    2, 'C4 时间锚未登记')

add('门12 C6 知识边界越界：甲在第2章才获知「暗号」，第1章同段已出现',
    'consistency_check.py', ch12,
    {'第01章.md': '甲念了一句暗号。\n', '第02章.md': '甲什么也没说。\n'},
    {'道具表': BASE_SHEETS['道具表'],
     '事件时间表': BASE_SHEETS['事件时间表'],
     '人物已知信息表': BASE_SHEETS['人物已知信息表']},
    2, 'C6 知识边界越界')

add('门12 C7 序数对象空/有矛盾：第九页既空又有墨',
    'consistency_check.py', ch12,
    {'第01章.md': '第九页是空的。\n', '第02章.md': '第八页的墨比第九页新。\n'},
    {'道具表': BASE_SHEETS['道具表'],
     '事件时间表': BASE_SHEETS['事件时间表'],
     '人物已知信息表': [BASE_SHEETS['人物已知信息表'][0]]},
    2, 'C7 序数对象空/有矛盾')

add('门12 特异度：账本与正文一致 → 放行',
    'consistency_check.py', ch12,
    {'第01章.md': CLEAN_CH1, '第02章.md': CLEAN_CH2},
    {'道具表': [BASE_SHEETS['道具表'][0],
                ['铜钥匙', '', '第1章', 1, '在场', '甲', '桌上'],
                ['铜钥匙', '', '', 2, '在场', '甲', '袖子']],
     '事件时间表': BASE_SHEETS['事件时间表'],
     '人物已知信息表': [BASE_SHEETS['人物已知信息表'][0]]},
    0, '门12 通过')

# ── 门7 E项 句尾复用 + 豁免 ─────────────────────────────────────
TAIL_A = '天上没有云，月亮很亮，坟坑一排一排，白的，整整齐齐。\n'
TAIL_B = '云散了一半，月亮露出来，照着那排坟坑，白的，整整齐齐。\n'


def dup_args(d, tp):
    return [os.path.join(d, '第01章.md'), os.path.join(d, '第02章.md'), '--tables', tp]


add('门7E 句尾复用命中：两章句尾同为「白的整整齐齐」',
    'dup_check.py', dup_args,
    {'第01章.md': TAIL_A, '第02章.md': TAIL_B},
    {'伏笔钩子台账': [BASE_SHEETS['伏笔钩子台账'][0],
                      ['F09', '伏笔', '不相关', '第9章', '第9章', '变奏', '否', '未回收', '']]},
    2, '跨章句尾短语复用')

add('门7E 豁免：伏笔台账登记「埋设第1章 / 回收第2章」＝首尾呼应',
    'dup_check.py', dup_args,
    {'第01章.md': TAIL_A, '第02章.md': TAIL_B},
    {'伏笔钩子台账': [BASE_SHEETS['伏笔钩子台账'][0],
                      ['F01', '伏笔', '坟坑那句意象', '第1章', '第2章', '变奏', '否', '已回收', '']]},
    0, '重复与同构检查通过')

add('门7E 豁免：母题回调 + 回收方式=逐字',
    'dup_check.py', dup_args,
    {'第01章.md': TAIL_A, '第02章.md': TAIL_B},
    {'伏笔钩子台账': [BASE_SHEETS['伏笔钩子台账'][0],
                      ['F02', '母题回调', '白的，整整齐齐', '第1章', '第9章', '逐字', '是', '悬置', '']]},
    0, '重复与同构检查通过')


# ── 门13 设定表同步 ─────────────────────────────────────────────
def sync_args(d, tp):
    return ['--chapters', d, '--tables', tp]


SYNC_SHEETS_OK = {
    '章节细纲表': [['章号', '章名', '情绪崩口位', '蓄势位', '章尾模式'],
                   [1, '一', '说吧。', '长段', '爽点'],
                   [2, '二', '停下。', '长段', '静默']],
    '节奏查询表': [['章号', '节奏档位', '章尾模式'],
                   [1, '失控', '爽点'], [2, '推进', '静默']],
    '事件时间表': [['章号', '绝对时间（第N天）', '事件（唯一名）'],
                   [1, '第1天', '开场事件'], [2, '第2天', '次日事件']],
}

add('门13 表同步：正文有第2章但章节细纲表缺第2章 → 打回',
    'table_sync_check.py', sync_args,
    {'第01章.md': '甲走了。\n', '第02章.md': '甲回来。\n'},
    {'章节细纲表': [['章号', '章名', '情绪崩口位', '蓄势位', '章尾模式'],
                    [1, '一', '说吧。', '长段', '爽点']],
     '节奏查询表': SYNC_SHEETS_OK['节奏查询表'],
     '事件时间表': SYNC_SHEETS_OK['事件时间表']},
    2, '缺第2章的行')

add('门13 特异度：表覆盖全部已写章节 → 通过',
    'table_sync_check.py', sync_args,
    {'第01章.md': '甲走了。\n', '第02章.md': '甲回来。\n'},
    SYNC_SHEETS_OK,
    0, '门13 通过')

# ── 门14 语癖卡对表 ─────────────────────────────────────────────
VOICE_CARD = {
    '主角设定表': [['姓名', '别名/外号', '口头禅', '句长偏好', '标点习惯',
                    '损法/怼人方式', '称呼习惯', '禁用方式（绝不这么说）'],
                   ['甲', '', '行吧', '短句为主', '句号多', '沉默式', '', '禁用：装逼']],
    '配角设定表': [['姓名', '定位', '口头禅', '句长偏好', '损法', '禁用方式'],
                   ['乙', '盟友', '', '短句', '', '禁用：老子']],
}

add('门14 语癖卡：甲的对白出现登记禁用词「装逼」 → 打回',
    'voice_table_check.py', sync_args,
    {'第01章.md': '甲说：“这话太装逼了。”\n'},
    VOICE_CARD,
    2, '禁用方式')

add('门14 特异度：对白未出现禁用词 → 通过',
    'voice_table_check.py', sync_args,
    {'第01章.md': '甲说：“这话不对。”\n'},
    VOICE_CARD,
    0, '门14 通过')

# P6（V0.41.1）：描述性登记不再逐条假报警——汇总一行跳过
VOICE_CARD_DESC = {
    '主角设定表': [['姓名', '别名/外号', '口头禅', '句长偏好', '标点习惯',
                    '损法/怼人方式', '称呼习惯', '禁用方式（绝不这么说）'],
                   ['甲', '', '行话不离口', '短句为主', '句号多', '沉默式', '', '不喊口号']],
    '配角设定表': [['姓名', '定位', '口头禅', '句长偏好', '损法', '禁用方式'],
                   ['乙', '盟友', '敬语反讽', '短句', '', '不说重话']],
}

add('门14 描述性登记（"行话不离口"）：汇总一行跳过、不逐条假报警 → 通过',
    'voice_table_check.py', sync_args,
    {'第01章.md': '甲说：“这话不对。”\n'},
    VOICE_CARD_DESC,
    0, '描述性登记')


# ── 门15 规划表完整性 ───────────────────────────────────────────
PLAN_OK = ('| 编号 | 功能 | 字数 | 内容要点 / 状态变更 |\n|---|---|---|---|\n'
           + '\n'.join(f'| P{i:02d} | 动作 | 100 | 要点{i} |' for i in range(1, 31)))
PLAN_BAD = ('| 编号 | 功能 | 字数 | 内容要点 / 状态变更 |\n|---|---|---|---|\n'
            '| P01 | 动作 | 100 |  |\n| P02 |  | 100 | 要点 |\n')


def plan_args(d, tp):
    return ['--plan', os.path.join(d, 'plan.md'), '--chapters-dir', d]


add('门15 规划表：缺必填列 + 字数预算越界 → 打回',
    'plan_check.py', plan_args,
    {'第01章.md': '甲走了。\n'},
    {}, 2, '缺必填列',
    extra={'plan.md': PLAN_BAD})

add('门15 特异度：必填列齐全、字数在区间内 → 通过',
    'plan_check.py', plan_args,
    {'第01章.md': '甲走了。\n'},
    {}, 0, '门15 通过',
    extra={'plan.md': PLAN_OK})

# ── 门16 节奏（连续爽点） ────────────────────────────────────────
def rhythm_args(d, tp):
    return ['--tables', tp]


RHY_BAD = {
    '节奏查询表': [['章号', '节奏档位', '章尾模式', '爽点连续计数', '失败章', '疲惫段',
                    '冲突解决方式', '钩子'],
                   [1, '失控', '爽点', 1, '否', '否', '—', '有'],
                   [2, '爆点', '爽点', 2, '否', '否', '—', '有'],
                   [3, '爆点', '爽点', 3, '否', '否', '—', '有']],
    '章节细纲表': [['章号', '章名', '章节标题风格', '章尾模式', '失控事件'],
                   [1, '一', '事件式', '爽点', '甲跑了'],
                   [2, '二', '事件式', '爽点', '甲打了一架'],
                   [3, '三', '事件式', '爽点', '甲追了上去']],
}
RHY_OK = {
    '节奏查询表': [['章号', '节奏档位', '章尾模式', '爽点连续计数', '失败章', '疲惫段',
                    '冲突解决方式', '钩子'],
                   [1, '失控', '爽点', 1, '否', '否', '—', '有'],
                   [2, '推进', '静默', 0, '否', '否', '—', '有'],
                   [3, '爆点', '爽点', 1, '否', '否', '—', '有']],
    '章节细纲表': RHY_BAD['章节细纲表'],
}

add('门16 节奏：连续 3 章"爽点"章尾 → 打回',
    'rhythm_check.py', rhythm_args,
    {'第01章.md': '甲走了。\n'}, RHY_BAD, 2, '连续')

add('门16 特异度：2 章爽点后转静默 → 通过',
    'rhythm_check.py', rhythm_args,
    {'第01章.md': '甲走了。\n'}, RHY_OK, 0, '门16 通过')

# ── 门17 受控瑕疵（只报警，永不 exit 2） ─────────────────────────
# V0.40.8 门精简：登记清单为空（未启用受控瑕疵）时不再输出"登记 0 条"报警，
# 改为汇总说明并跳过核对（清单非空时 <1/>2/被洗掉/禁落位置仍报警）。
add('门17 受控瑕疵：登记清单为空（未启用）→ 跳过核对、exit 0',
    'imperfection_check.py',
    lambda d, tp: ['--chapters', d],
    {'第01章.md': '甲走了。\n'}, {},
    0, '清单为空')

# ── 合并入口（方案B：门4/门5/门6） ───────────────────────────────
def merged_files_args(d, tp):
    return ['--files', os.path.join(d, '第01章.md'), os.path.join(d, '第02章.md'),
            '--tables', tp]


def merged_ch_args(d, tp):
    return ['--chapters', d, '--tables', tp]


add('门4 合并入口 repeat_check：跨章逐字复读 → 打回',
    'repeat_check.py', merged_files_args,
    {'第01章.md': '他想起行会值班房墙上那块木板。\n',
     '第02章.md': '他忽然想起行会值班房墙上那块木板。\n'},
    {'伏笔钩子台账': [BASE_SHEETS['伏笔钩子台账'][0]]},
    2, '门4 打回')

add('门5 合并入口 ledger_check：表缺行 → 打回',
    'ledger_check.py', merged_ch_args,
    {'第01章.md': '甲走了。\n', '第02章.md': '甲回来。\n'},
    {'章节细纲表': [['章号', '章名', '情绪崩口位', '蓄势位', '章尾模式'],
                    [1, '一', '说吧。', '长段', '爽点']],
     '节奏查询表': SYNC_SHEETS_OK['节奏查询表'],
     '事件时间表': SYNC_SHEETS_OK['事件时间表'],
     '主角设定表': VOICE_CARD['主角设定表']},
    2, '门5 打回')

add('门6 合并入口 process_check：连续3章爽点 → 打回',
    'process_check.py', merged_ch_args,
    {'第01章.md': '甲走了。\n'}, RHY_BAD, 2, '门6 打回')


# ── 门7 分布对齐（V0.38 新增）────────────────────────────────────
# 合成稿：好稿各指标落西幻章级档内；坏稿均句长/句长sd 三章连续低于下限。
_S_NEU = ['他走到窗边停下', '桌上的灯还亮着', '门轴响了一声', '街上没有人', '他把纸摊平',
          '笔尖在纸上顿住', '走廊尽头传来脚步', '他数了数口袋里的铜板', '他伸手把椅子拉近',
          '柜子第三格是空的', '他抬眼看了看钟', '屋里安静下来', '他把外套搭在椅背上',
          '院子里有人在劈柴', '桌上的账本翻到一半', '他吹灭了蜡烛', '他把靴子脱在门口',
          '楼梯吱呀响了两声', '案卷堆到齐腰高', '他换了个坐姿', '壶里的水开了',
          '他抹了把脸', '那人的手指敲着桌面', '他把袖子往上撸了撸', '有人在楼下喊了一声',
          '他把茶碗推过去', '纸角被风掀起又落下', '他捏着笔杆没动', '孩子跑过去撞了桌角',
          '他低头把鞋带系紧', '那人从怀里摸出个布包', '他把名字写在最后一栏',
          '两人隔着桌子坐着', '他把话咽了回去', '灯芯爆了个小火花']
_S_POS = ['他心里松快了些', '笑意从眼底漫上来', '胸口暖了一阵', '他忍不住咧了咧嘴',
          '这话说得他舒坦', '他把肩上的劲卸了', '他觉得今天运气不错', '有人递过来一碗热汤',
          '他痛快地应了一声', '他把事情办得漂亮', '对方冲他点了点头', '他心里踏实了',
          '他舒了口气', '他笑得眼睛都眯起来']
_S_NEG = ['掌心全是冷汗', '胃里一阵翻搅', '喉咙像塞了团棉', '他心里发沉', '手指抖了一下',
          '他闭了闭眼压住火气', '那味道让他恶心', '他后悔得咬了牙', '他怕得连腿都软了',
          '胸口闷得喘不上气', '他恨自己多嘴', '眼角发酸', '他觉得累了', '他恶心得直皱眉',
          '他心里发慌', '他烦躁地敲了下桌角']
_S_CONN = ['不过', '只是', '后来', '半晌', '等到', '于是', '接着', '随后', '反正', '因此',
           '同时', '之后', '结果', '然后']


def _synth_sentence(rng, target):
    parts, n = [], 0
    pool = _S_NEU + _S_NEU + _S_POS + _S_NEG
    while n < target:
        w = rng.choice(pool)
        parts.append(w)
        n += len(w)
    s = '，'.join(parts)
    if rng.random() < 0.3:
        s = rng.choice(_S_CONN) + '，' + s
    if rng.random() < 0.12:
        s += '。' + rng.choice(['“行吧。”', '“知道了。”', '“再等等。”', '“谁？”', '“怎么？”'])
    return s + '。'


def synth_good(seed=1):
    """指标落西幻章级档内的合成章（用于证明门7 不会误伤）。"""
    import random
    rng = random.Random(seed)
    paras = []
    for _ in range(78):
        cap = rng.randint(16, 64)
        sents, total = [], 0
        for _ in range(rng.choice([1, 1, 1, 2, 2, 2, 3])):
            r = rng.random()
            t = (rng.randint(7, 13) if r < 0.4 else
                 rng.randint(16, 26) if r < 0.8 else rng.randint(30, 42))
            s = _synth_sentence(rng, t)
            if total + len(s) > cap and sents:
                break
            sents.append(s)
            total += len(s)
        paras.append(''.join(sents))
    return '\n'.join(paras) + '\n'


def synth_bad_short(seed=2):
    """均句长/句长sd 远低于下限的合成章（用于证明门7 会打回）。"""
    import random
    rng = random.Random(seed)
    return '\n'.join(
        ''.join(_synth_sentence(rng, rng.randint(6, 10)) for _ in range(2))
        for _ in range(90)) + '\n'


def dist_args(d, tp):
    return ['--chapters', os.path.join(d, '*.md'), '--genre', '西幻/异世界', '--quiet']


def dist_args_exempt(d, tp):
    return ['--chapters', os.path.join(d, '*.md'), '--genre', '西幻/异世界', '--quiet',
            '--exempt', os.path.join(d, 'exempt.json')]


_EXEMPT_ALL = ('{"第01章.md": ["均句长", "句长sd"], "第02章.md": ["均句长", "句长sd"], '
               '"第03章.md": ["均句长", "句长sd"]}')

add('门7 坏稿：三章均句长/句长sd 连续低于下限 → 打回',
    'dist_check.py', dist_args,
    {'第01章.md': synth_bad_short(11), '第02章.md': synth_bad_short(12),
     '第03章.md': synth_bad_short(13)}, {},
    2, '连续 3 章越界')

add('门7 好稿：各指标落西幻章级档内 → 放行',
    'dist_check.py', dist_args,
    {'第01章.md': synth_good(21), '第02章.md': synth_good(22),
     '第03章.md': synth_good(23)}, {},
    0, '门7 结果：通过')

add('门7 豁免：坏稿登记豁免白名单 → 不打回',
    'dist_check.py', dist_args_exempt,
    {'第01章.md': synth_bad_short(11), '第02章.md': synth_bad_short(12),
     '第03章.md': synth_bad_short(13)},
    {}, 0, '门7 结果：通过', extra={'exempt.json': _EXEMPT_ALL})


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    return p.returncode, (p.stdout or '') + (p.stderr or '')

def main():
    print('=' * 72)
    print('机器门回归测试（坏稿必命中 / 好稿必放行 / 豁免必生效）')
    print('=' * 72)
    root = tempfile.mkdtemp(prefix='gate_reg_')
    failed = []
    try:
        for c in CASES:
            safe = re.sub(r'[<>:"/\\|?*\s]+', '_', c['name'])[:28]
            d, tp = make_case(root, safe, c['chapters'], c['sheets'], c.get('extra'))
            cmd = [PY, os.path.join(GATES, c['gate'])] + c['args'](d, tp)
            rc, out = run(cmd)
            ok = (rc == c['expect_exit']) and (c['expect_text'] in out)
            print(f'\n[{"PASS" if ok else "FAIL"}] {c["name"]}')
            print(f'        {c["gate"]}  退出码={rc}（期望{c["expect_exit"]}）  '
                  f'命中={c["expect_text"] in out}')
            if not ok:
                failed.append(c['name'])
                for line in out.splitlines():
                    if c['expect_text'][:6] in line or '打回' in line:
                        print('        > ' + line.strip())
    finally:
        shutil.rmtree(root, ignore_errors=True)
    print('\n' + '=' * 72)
    if failed:
        print(f'回归失败 {len(failed)}/{len(CASES)} 项：')
        for f in failed:
            print('  - ' + f)
        return 2
    print(f'回归全部通过（{len(CASES)}/{len(CASES)}）：判据该报的报、不该报的不报、豁免生效。')
    return 0


if __name__ == '__main__':
    sys.exit(main())

