/** Isolated audit fixtures only. Never import from application code. */
import { createCipheriv, createECDH, createHash, randomBytes } from "node:crypto";

export function fixtureKey() {
  const key = createECDH("secp256k1"); key.generateKeys();
  return key.getPrivateKey("hex");
}
export function fixtureSession(privateKey: string, userId: string) {
  const recipient = createECDH("secp256k1"); recipient.setPrivateKey(Buffer.from(privateKey, "hex"));
  const ephemeral = createECDH("secp256k1"); ephemeral.generateKeys();
  const wrapKey = createHash("sha256").update(ephemeral.computeSecret(recipient.getPublicKey())).digest();
  const aesKey = randomBytes(32), wrapIv = randomBytes(16), iv = randomBytes(12);
  const wrap = createCipheriv("aes-256-cbc", wrapKey, wrapIv);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  const encryptedData = Buffer.concat([cipher.update(JSON.stringify({ userId, nickname: `Audit ${userId}` }), "utf8"), cipher.final()]);
  return JSON.stringify({
    encryptedData: encryptedData.toString("base64"),
    encryptedKey: Buffer.concat([ephemeral.getPublicKey(undefined, "compressed"), wrapIv, wrap.update(aesKey), wrap.final()]).toString("base64"),
    iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64"),
  });
}
export const ORIGINAL_TEXT = `第一章 雨夜的灯
雨停的时候，旧站台只剩一盏还亮着的灯。值夜的修表人把最后一把椅子搬进屋里，听见门外有人敲了三下。他从窗缝看出去，那里没有人，只有一只湿透的纸箱。纸箱上贴着一张收据，日期却写着明天。
他没有急着打开箱子，而是先去检查那盏灯。灯泡刚换过，接线却被人重新拧成一个陌生的结。他想起送灯泡来的孩子，想起孩子临走前说，明天不要等我。此刻站外的路上已经没有脚印。
他把收据压在工作台的玻璃下，抄下日期，又在旁边写上今晚的时刻。每写一个字，纸箱里便轻轻响一下。等到最后一笔落下，响声忽然停了。修表人握紧工具，终于掀开纸箱的一角。
第二章 不寄出的信
箱子里没有钟表，只有一封没有地址的信。他先把信放到灯下，让潮气慢慢散开。窗外的车站广播终于响了，却只念了一遍他的工号。这个工号在车站停运那天就已经注销。
他听完广播，仔细锁好工具柜，拿出一张空白车票。车票背面还留着师傅教他画的路线，没有终点。他沿着纸上的线用手指走了一遍，把今晚发生的事写在空白处，决定天亮之后亲自去找送灯泡的孩子。`;
export type MockMode = "ok" | "credit" | "invalid-json" | "false-evidence" | "truncated" | "network" | "huge" | "slow" | "partial";
export function fixtureCompletion(body: Record<string, unknown>, mode: MockMode = "ok") {
  const messages = body.messages as { content: string }[];
  const input = JSON.parse(messages[1]!.content) as { requestedKinds: string[]; segments: { segment: number; text: string }[] };
  const segment = input.segments.find(s => s.text.length >= 12)!;
  const cards = input.requestedKinds.map(kind => ({ kind, title: `${kind}：先给可核对的异常`, principle: "先确立日常基准，再让一个可感知细节偏离基准，引导读者提出具体问题。", application: "在原创情境中选择普通动作和一个独立异常，让角色先核对再行动；不要移用来源人物和情节。", caution: "仅根据当前片段提炼，不代表全书；过密的异常会削弱可信度。", segment: segment.segment, quote: mode === "false-evidence" ? "这里不存在的证据句子" : segment.text.slice(0, 24) }));
  return { choices: [{ finish_reason: mode === "truncated" ? "length" : "stop", message: { content: mode === "invalid-json" ? "not valid JSON" : JSON.stringify({ cards }) } }], usage: { total_tokens: 321 } };
}
