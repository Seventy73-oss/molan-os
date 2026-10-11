import { t as tr, useLocale, getLocale } from "../lib/i18n";
import { useEffect, useState } from "react";
import { api, THINKING_OPTIONS, type AgentRuntimeInfo, type ModelsList, type ProviderSettings, type Route, type ThinkingIntensity, type UsageSummary } from "../api";
import { useBookTitle } from "../App";
import { ModelPicker } from "../components/ModelPicker";

const ORDER = [
  ["outline", "全书大纲", "生成整本书大纲时用"],
  ["chapter_outline", "细纲", "写某一章细纲时用"],
  ["chapter_body", "正文", "写章正文时用"],
  ["review", "审核", "审稿与问题清单"],
  ["memory_extract", "记忆", "抽本章事实与钩子"],
  ["chat", "对话", "助手闲聊与问答（不写稿）"],
  ["humanize", "去 AI 味", "润色；选区改写也常用"],
  ["book_setup", "建书", "一句话建书"],
  ["topic", "选题", "题材方案"],
] as const;

const PRESETS = [
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "siliconflow", name: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3" },
  { id: "moonshot", name: "Moonshot", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-auto" },
  { id: "custom", name: "自定义", baseUrl: "", model: "" },
] as const;

const EMPTY: ProviderSettings = {
  baseUrl: "",
  hasApiKey: false,
  apiKeyHint: null,
  defaultModel: "",
  chatModel: "",
  configured: false,
  keySource: "none",
};

function normalize(routes: Route[]): Route[] {
  const map = new Map(routes.map((route) => [route.scene, route]));
  return ORDER.map(([scene]) => {
    const hit = map.get(scene);
    return {
      scene,
      provider: hit?.provider ?? "local",
      modelId: hit?.modelId ?? "local-draft",
      baseUrl: hit?.baseUrl ?? null,
      thinkingIntensity: (hit?.thinkingIntensity as ThinkingIntensity | undefined) ?? "medium",
    };
  });
}

function formatFetched(iso: string | null) {
  if (!iso) return "尚未拉取";
  try {
    return new Date(iso).toLocaleString(getLocale(), { hour12: false });
  } catch {
    return iso;
  }
}

export function Models() {
  useLocale();
  const { setTitle } = useBookTitle();
  const [routes, setRoutes] = useState<Route[]>([]);
  const [savedRoutes, setSavedRoutes] = useState("");
  const [provider, setProvider] = useState<ProviderSettings>(EMPTY);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [preset, setPreset] = useState("custom");
  const [models, setModels] = useState<ModelsList>({ models: [], fetchedAt: null });
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [runtime, setRuntime] = useState<AgentRuntimeInfo | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const routesDirty = JSON.stringify(routes) !== savedRoutes;

  useEffect(() => {
    function onLeave(event: BeforeUnloadEvent) {
      if (!routesDirty) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [routesDirty]);


  useEffect(() => {
    setTitle("");
    let cancel = false;
    Promise.all([api.routes(), api.provider(), api.agentRuntime().catch(() => null)])
      .then(([routeRes, settings, runtimeInfo]) => {
        if (cancel) return;
        const next = normalize(routeRes.routes);
        setRoutes(next);
        setSavedRoutes(JSON.stringify(next));
        applySettings(settings);
        if (runtimeInfo) setRuntime(runtimeInfo);
      })
      .catch((err: Error) => {
        if (!cancel) setError(err.message);
      });
    // Models list is optional: a 404/restart must not blank 场景路由.
    api.providerModels()
      .then((modelRes) => {
        if (!cancel) setModels(modelRes);
      })
      .catch((err: Error) => {
        if (!cancel) setModels({ models: [], fetchedAt: null, error: err.message });
      });
    api.usageSummary()
      .then((sum) => {
        if (!cancel) setUsage(sum);
      })
      .catch(() => {
        if (!cancel) setUsage(null);
      });
    return () => {
      cancel = true;
    };
  }, [setTitle]);

  function applySettings(settings: ProviderSettings) {
    setProvider(settings);
    setBaseUrl(settings.baseUrl);
    setDefaultModel(settings.defaultModel || settings.chatModel);
    setApiKey("");
    const hit = PRESETS.find((item) => item.baseUrl && item.baseUrl === settings.baseUrl);
    setPreset(hit?.id ?? "custom");
  }

  function update(scene: string, patch: Partial<Route>) {
    setRoutes((list) => list.map((route) => (route.scene === scene ? { ...route, ...patch } : route)));
  }

  function pickPreset(id: string) {
    const item = PRESETS.find((entry) => entry.id === id);
    if (!item) return;
    setPreset(id);
    setBaseUrl(item.baseUrl);
    if (item.model && !defaultModel.trim()) setDefaultModel(item.model);
  }

  async function pullModels() {
    const list = await api.refreshProviderModels();
    setModels(list);
    return list;
  }

  async function saveProvider() {
    setBusy("save");
    setError("");
    setNotice("");
    try {
      const next = await api.saveProvider({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        defaultModel: defaultModel.trim(),
        chatModel: defaultModel.trim(),
      });
      applySettings(next);
      if (next.configured) {
        const list = await api.providerModels();
        setModels(list);
        setNotice(list.error ? `接口已保存。模型列表：${list.error}` : `接口已保存 · ${list.models.length} 个模型`);
      } else {
        setNotice(next.hasApiKey ? "已保存。还没有 Base URL。" : "已保存。还没有密钥，暂时不能调用。");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy("");
    }
  }

  async function clearKey() {
    setBusy("clear");
    setError("");
    setNotice("");
    try {
      const next = await api.saveProvider({ clearApiKey: true });
      applySettings(next);
      setNotice("密钥已清除");
    } catch (err) {
      setError(err instanceof Error ? err.message : "清除失败");
    } finally {
      setBusy("");
    }
  }

  async function test() {
    setBusy("test");
    setError("");
    setNotice("");
    try {
      const result = await api.testProvider({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        model: defaultModel.trim(),
      });
      if (result.ok) {
        const list = await api.providerModels();
        setModels(list);
        setNotice(`连接成功 · ${result.model}${list.error ? `（模型列表：${list.error}）` : ` · ${list.models.length} 个模型`}`);
      } else {
        setNotice(result.error || "连接失败");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "连接失败");
    } finally {
      setBusy("");
    }
  }

  async function refresh() {
    setBusy("models");
    setError("");
    try {
      const list = await pullModels();
      setNotice(list.error ? list.error : `已刷新 · ${list.models.length} 个模型`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "刷新失败");
    } finally {
      setBusy("");
    }
  }

  async function saveRoutes(next = routes) {
    setBusy("routes");
    setError("");
    try {
      const res = await api.saveRoutes(next);
      const normalized = normalize(res.routes);
      setRoutes(normalized);
      setSavedRoutes(JSON.stringify(normalized));
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy("");
    }
  }

  async function useOpenAI() {
    const model = defaultModel.trim() || "gpt-4o-mini";
    const next = routes.map((route) => ({
      ...route,
      provider: "openai",
      modelId: route.provider === "openai" && route.modelId !== "local-draft" ? route.modelId : model,
    }));
    setRoutes(next);
    await saveRoutes(next);
    setNotice(provider.configured ? "全部场景已改用 OpenAI 兼容接口" : "已改用 OpenAI 兼容，但还没填密钥——配置后才能生成");
  }

  async function useLocal() {
    const next = routes.map((route) => ({ ...route, provider: "local", modelId: "local-draft", baseUrl: null }));
    setRoutes(next);
    await saveRoutes(next);
    setNotice("全部场景已改回本地草稿");
  }

  const keyPlaceholder = provider.hasApiKey
    ? provider.keySource === "env"
      ? `环境变量 · ${provider.apiKeyHint ?? "••••"} · 留空不改库内密钥`
      : `已保存 · ${provider.apiKeyHint ?? "••••"} · 留空则不改`
    : "sk-…";

  return (
    <div className="page page-enter models-page settings-page">
      <header className="page-head">
        <div>
          <p className="eyebrow"><span className="eyebrow-line" />{tr("为灵感接上引擎")}</p>
          <h1>{tr("模型")}<span className="heading-dot" aria-hidden="true">.</span></h1><span className="page-english-title" aria-hidden="true">THE ENGINE</span>
          <p className="sub">{tr("连接你信赖的模型，为不同的写作场景选择不同的搭档。")}</p>
        </div>
      </header>
      {error ? <p className="alert">{tr(error)}</p> : null}
      {notice ? <p className="form-notice">{tr(notice)}</p> : null}
      {!provider.configured && routes.some((route) => route.provider === "openai") ? (
        <p className="callout warn">{tr("有场景已切到 OpenAI 兼容，但还没填 API Key，暂时无法生成。请在下面的「接口」里保存 Base URL 和密钥。")}</p>
      ) : null}
      {!provider.configured && routes.every((route) => route.provider !== "openai") ? (
        <p className="callout">{tr("当前全部场景走本地草稿引擎，适合起稿。接上兼容接口后，选区改写和正文生成会明显更稳。")}</p>
      ) : null}




      <section className="panel provider-card">
        <div className="provider-head">
          <div>
            <h2>{tr("接口")}</h2>
            <p>{tr("OpenAI 以及 DeepSeek、SiliconFlow、Moonshot 这类兼容接口。")}</p>
          </div>
          <span className={provider.configured ? "pill on" : "pill"}>{provider.configured ? tr("已配置") : tr("未配置")}</span>
        </div>
        <div className="presets" role="group" aria-label={tr("接口预设")}>
          {PRESETS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={preset === item.id ? "chip on" : "chip"}
              onClick={() => pickPreset(item.id)}
            >
              {tr(item.name)}
            </button>
          ))}
        </div>
        <div className="provider-grid">
          <label>
            Base URL
            <input
              value={baseUrl}
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setPreset("custom");
              }}
            />
          </label>
          <label>
            API Key
            <span className="secret">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                placeholder={keyPlaceholder}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <button type="button" className="ghost-mini" onClick={() => setShowKey((v) => !v)}>
                {showKey ? tr("隐藏") : tr("显示")}
              </button>
            </span>
          </label>
          <label>{tr("默认模型")}<ModelPicker
              value={defaultModel}
              models={models.models}
              placeholder="gpt-4o-mini / deepseek-chat"
              onChange={setDefaultModel}
            />
          </label>
        </div>
        <p className="provider-security">{tr("密钥加密保存在服务器，仅返回尾号提示。请使用可信的接口地址。")}</p>
        <div className="model-meta">
          <span>{models.error ? tr("列表：{p0}", { p0: tr(models.error) }) : tr("已缓存 {p0} 个模型", { p0: models.models.length })}</span>
          <span>·</span>
          <span>{tr(formatFetched(models.fetchedAt))}</span>
          <button type="button" className="text-link" disabled={busy !== ""} onClick={() => void refresh()}>
            {busy === "models" ? tr("刷新中…") : tr("刷新模型")}
          </button>
        </div>
        <div className="actions">
          <button type="button" className="btn primary" disabled={busy !== ""} onClick={() => void saveProvider()}>
            {busy === "save" ? tr("保存中…") : tr("保存接口")}
          </button>
          <button type="button" className="btn" disabled={busy !== "" || !provider.hasApiKey} onClick={() => void clearKey()}>{tr("清除密钥")}</button>
          <button type="button" className="btn" disabled={busy !== ""} onClick={() => void test()}>
            {busy === "test" ? tr("测试中…") : tr("测试连接")}
          </button>
        </div>
      </section>

      <section className="route-section">
        <div className="route-head">
          <div>
            <h2>{tr("场景路由")}</h2>
            <p>{tr("正文、审核、全书大纲、细纲等可各自选不同模型和思考强度。留空接口地址用上面的 Base URL；模型选「使用默认模型」则跟默认模型走。思考强度会映射到推理力度 / 温度；不支持的接口会降级为提示词约束。")}</p>
          </div>
          <div className="actions">
            <button type="button" className="btn" disabled={busy !== ""} onClick={() => void useOpenAI()}>{tr("全部场景改用 OpenAI 兼容")}</button>
            <button type="button" className="btn" disabled={busy !== ""} onClick={() => void useLocal()}>{tr("全部改回本地")}</button>
            <button type="button" className={routesDirty ? "btn primary" : "btn"} disabled={!routesDirty || busy !== ""} onClick={() => void saveRoutes()}>
              {busy === "routes" ? tr("保存中…") : routesDirty ? tr("保存路由") : tr("路由已保存")}
            </button>
          </div>
        </div>
        <div className="panel route-list">
          <div className="route-row head">
            <span>{tr("场景")}</span>
            <span>{tr("来源")}</span>
            <span>{tr("模型")}</span>
            <span>{tr("思考强度")}</span>
            <span>{tr("接口地址")}</span>
          </div>
          {ORDER.map(([scene, label, hint]) => {
            const route = routes.find((item) => item.scene === scene);
            if (!route) return null;
            const remote = route.provider === "openai";
            return (
              <div className="route-row" key={scene}>
                <div className="route-name">
                  <strong>{tr(label)}</strong>
                  <span className="route-hint">{tr(hint)}</span>
                </div>
                <select value={route.provider} aria-label={tr("{p0}来源", { p0: tr(label) })} onChange={(e) => update(scene, { provider: e.target.value })}>
                  <option value="local">{tr("本地草稿")}</option>
                  <option value="openai">{tr("OpenAI 兼容")}</option>
                </select>
                {remote ? (
                  <ModelPicker
                    value={route.modelId === "local-draft" ? "" : route.modelId}
                    models={models.models}
                    placeholder={tr("默认模型 / 自定义")}
                    allowEmpty
                    emptyLabel={tr("使用默认模型")}
                    onChange={(value) => update(scene, { modelId: value || "local-draft" })}
                  />
                ) : (
                  <input value="local-draft" disabled aria-label={tr("{p0}模型", { p0: tr(label) })} />
                )}
                <select
                  value={route.thinkingIntensity ?? "medium"}
                  aria-label={tr("{p0}思考强度", { p0: tr(label) })}
                  title={tr("思考强度：关闭 / 低 / 中 / 高")}
                  onChange={(e) => update(scene, { thinkingIntensity: e.target.value as ThinkingIntensity })}
                >
                  {THINKING_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {tr(opt.label)}
                    </option>
                  ))}
                </select>
                <input
                  value={route.baseUrl ?? ""}
                  aria-label={tr("{p0}接口地址", { p0: tr(label) })}
                  placeholder={remote ? tr("留空则用共用地址") : tr("本地不需要")}
                  disabled={!remote}
                  spellCheck={false}
                  onChange={(e) => update(scene, { baseUrl: e.target.value.trim() ? e.target.value : null })}
                />
              </div>
            );
          })}
        </div>
      </section>
      {runtime ? (
        <section className="panel runtime-card">
          <div className="provider-head">
            <div>
              <h2>{tr("写作运行时")}</h2>
              <p>{tr("当前可用的适配器。pi-agent 仅为模型代调（不是自主工具编排）。已安装时可在路由或 MOLAN_AGENT_RUNTIME=pi 启用。")}</p>
            </div>
            {runtime.envRuntime ? <span className="pill">env: {runtime.envRuntime}</span> : <span className="pill">{tr("按场景路由")}</span>}
          </div>
          <ul className="runtime-list">
            {runtime.capabilities.map((cap) => (
              <li key={cap.id} className={cap.available ? "on" : "off"}>
                <strong>{tr(cap.label)}</strong>
                <span>{cap.available ? tr("可用") : tr("不可用")}</span>
                <p>{tr(cap.reason)}</p>
              </li>
            ))}
          </ul>
          <p className="muted runtime-note">{tr(runtime.note)}</p>
          {runtime.pi ? (
            <p className="muted runtime-note" data-testid="pi-boundary">{tr("pi 边界：")}{tr(runtime.pi.note)}（autonomous={String(runtime.pi.autonomous)} / tools={String(runtime.pi.toolsSupported)}）
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="card usage-card" aria-label={tr("API 用量")}>
        <header className="card-head">
          <h2>{tr("用量与费用")}</h2>
          <button
            type="button"
            className="btn small ghost"
            onClick={() => {
              void api.usageSummary().then(setUsage).catch(() => setUsage(null));
            }}
          >{tr("刷新")}</button>
        </header>
        {!usage ? (
          <p className="muted">{tr("还没有调用记录。接上模型后会按次估算 token 与费用。")}</p>
        ) : (
          <>
            <div className="usage-stats">
              <div><strong>{usage.calls}</strong><span>{tr("次调用")}</span></div>
              <div><strong>{usage.totalTokens.toLocaleString(getLocale())}</strong><span>tokens</span></div>
              <div><strong>${usage.estimatedCost.toFixed(4)}</strong><span>{tr("估算费用")}</span></div>
              <div><strong>{usage.localCalls}</strong><span>{tr("本地草稿")}</span></div>
            </div>
            {usage.byModel.length ? (
              <div className="usage-tables">
                <h3>{tr("按模型")}</h3>
                <ul>
                  {usage.byModel.slice(0, 8).map((row) => (
                    <li key={row.model}>
                      <span>{row.model}</span>
                      <span>{row.calls}{tr(" 次 · ")}{row.totalTokens} tok · ${row.estimatedCost.toFixed(4)}</span>
                    </li>
                  ))}
                </ul>
                <h3>{tr("按书")}</h3>
                <ul>
                  {usage.byBook.slice(0, 8).map((row) => (
                    <li key={row.bookId ?? "none"}>
                      <span>{row.title}</span>
                      <span>{row.calls}{tr(" 次 · $")}{row.estimatedCost.toFixed(4)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </section>

    </div>
  );
}
