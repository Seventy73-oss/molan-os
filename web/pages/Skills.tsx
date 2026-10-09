import { useEffect, useState } from "react";
import { api, type Skill } from "../api";
import { useBookTitle } from "../App";

const SCENE: Record<string, string> = {
  topic: "选题",
  book_setup: "建书",
  outline: "大纲",
  chapter_outline: "细纲",
  chapter_body: "正文",
  review: "审核",
  humanize: "去 AI 味",
  memory_extract: "记忆整理",
};

export function Skills() {
  const { setTitle } = useBookTitle();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [current, setCurrent] = useState<string>("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    setTitle("");
    api.skills().then((res) => {
      setSkills(res.skills);
      setCurrent(res.skills[0]?.id ?? "");
    }).catch((err: Error) => {
      setError(err.message);
      setSkills([]);
    });
  }, [setTitle]);

  const list = skills ?? [];
  const selected = list.find((skill) => skill.id === current);
  const parsed = selected ? splitFrontmatter(selected.body) : null;

  async function reload() {
    setBusy("reload");
    setError("");
    try {
      const res = await api.reloadSkills();
      setSkills(res.skills);
      if (!res.skills.some((skill) => skill.id === current)) setCurrent(res.skills[0]?.id ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "重新载入失败");
    } finally {
      setBusy("");
    }
  }

  async function toggle(skill: Skill) {
    setError("");
    try {
      const next = await api.patchSkill(skill.id, !skill.enabled);
      setSkills((prev) => (prev ?? []).map((item) => (item.id === next.id ? next : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "切换失败");
    }
  }

  return (
    <div className="page page-enter skills-page settings-page">
      <header className="page-head">
        <div>
          <p className="eyebrow">墨兰写作 · 设置</p>
          <h1>技能</h1>
          <p className="sub">用户蒸馏包已完整接入：去 AI 味、开局拆解卡、卷级蒸馏、结构骨架、文风语料、选题创作。生成时按场景注入 pack 关键原文，不是空壳摘要。</p>
        </div>
        <div className="actions">
          <button type="button" className="btn" disabled={busy === "reload"} onClick={() => void reload()}>
            {busy === "reload" ? "载入中…" : "重新载入"}
          </button>
        </div>
      </header>
      {error ? <p className="alert">{error}</p> : null}
      <div className="skills-layout">
        <section className="panel skill-table">
          <div className="db-head">
            <span>名称</span>
            <span>场景</span>
            <span>角色</span>
            <span>启用</span>
          </div>
          {skills === null ? <p className="empty loading-line">正在载入技能…</p> : null}
          {skills && skills.length === 0 ? <p className="empty">还没有技能。把文件夹放进 skills/ 再点重新载入。</p> : null}
          {list.map((skill) => (
            <div
              key={skill.id}
              role="button"
              tabIndex={0}
              className={skill.id === current ? "db-row on" : "db-row"}
              onClick={() => setCurrent(skill.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter") setCurrent(skill.id);
              }}
            >
              <span className="db-name">{skill.name}</span>
              <span className="meta">{SCENE[skill.scene] ?? skill.scene}</span>
              <span className={skill.role === "primary" ? "role primary" : "role"}>{skill.role === "primary" ? "主技能" : "辅助"}</span>
              <button
                type="button"
                role="switch"
                aria-checked={skill.enabled}
                aria-label={`${skill.name}启用`}
                className={skill.enabled ? "toggle on" : "toggle"}
                onClick={(event) => {
                  event.stopPropagation();
                  void toggle(skill);
                }}
              >
                <i />
              </button>
            </div>
          ))}
        </section>
        <article className="panel reader">
          {selected ? (
            <>
              <div className="reader-head">
                <h2>{selected.name}</h2>
                {selected.description ? <p className="reader-desc">{selected.description}</p> : null}
                {["humanize", "opening-cards", "volume-arcs", "structure-skeleton", "style-corpus", "novel-craft"].includes(selected.id) ? (
                  <p className="reader-desc pack-note">用户完整包：skills/{selected.id}/pack/。提示词预览：/api/skills/{selected.id}/prompt-preview</p>
                ) : null}
                <p className="path">{selected.path}</p>
              </div>
              <pre className="skill-body">{parsed?.body ?? selected.body}</pre>
            </>
          ) : (
            <p className="empty">还没有技能。</p>
          )}
        </article>
      </div>
    </div>
  );
}

function splitFrontmatter(text: string): { body: string } {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return { body: match ? text.slice(match[0].length).replace(/^\s+/, "") : text };
}
