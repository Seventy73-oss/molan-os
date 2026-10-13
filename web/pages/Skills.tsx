import { t as tr, useLocale } from "../lib/i18n";
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
  chat: "对话",
};

function sceneLabel(id: string): string {
  return tr(SCENE[id] ?? id);
}

function attachLabel(skill: Skill): string {
  const home = sceneLabel(skill.scene);
  const extra = (skill.attachScenes ?? []).filter((s) => s !== skill.scene).map(sceneLabel);
  if (!skill.userPack || !extra.length) return home;
  return `${home} · 兼挂 ${extra.join("、")}`;
}

export function Skills() {
  useLocale();
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
          <p className="eyebrow"><span className="eyebrow-line" />{tr("你的写作方法")}</p>
          <h1>{tr("技能")}<span className="heading-dot" aria-hidden="true">.</span></h1><span className="page-english-title" aria-hidden="true">THE CRAFT</span>
          <p className="sub">{tr("从构思到润色，为每一个创作环节找到合适的方法。")}</p>
        </div>
        <div className="actions">
          <button type="button" className="btn" disabled={busy === "reload"} onClick={() => void reload()}>
            {busy === "reload" ? tr("载入中…") : tr("重新载入")}
          </button>
        </div>
      </header>
      {error ? <p className="alert">{tr(error)}</p> : null}
      <div className="skills-layout">
        <section className="panel skill-table">
          <div className="db-head">
            <span>{tr("名称")}</span>
            <span>{tr("场景")}</span>
            <span>{tr("角色")}</span>
            <span>{tr("启用")}</span>
          </div>
          {skills === null ? <p className="empty loading-line">{tr("正在载入技能…")}</p> : null}
          {skills && skills.length === 0 ? <p className="empty">{tr("还没有技能。把文件夹放进 skills/ 再点重新载入。")}</p> : null}
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
              <span className="meta" title={attachLabel(skill)}>{tr(attachLabel(skill))}</span>
              <span className={skill.role === "primary" ? "role primary" : "role"}>{skill.role === "primary" ? tr("主技能") : tr("辅助")}</span>
              <button
                type="button"
                role="switch"
                aria-checked={skill.enabled}
                aria-label={tr("{p0}启用", { p0: skill.name })}
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
                {selected.userPack || ["humanize", "opening-cards", "volume-arcs", "structure-skeleton", "style-corpus", "novel-craft"].includes(selected.id) ? (
                  <p className="reader-desc pack-note">{tr("用户完整包：skills/")}{selected.id}{tr("/pack/。按场景自动挂载：")}{(selected.attachScenes?.length ? selected.attachScenes : [selected.scene]).map(sceneLabel).join("、")}{tr("。提示词预览：/api/skills/")}{selected.id}/prompt-preview
                  </p>
                ) : null}
                <p className="path">{selected.path}</p>
              </div>
              <pre className="skill-body">{parsed?.body ?? selected.body}</pre>
            </>
          ) : (
            <p className="empty">{tr("还没有技能。")}</p>
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
