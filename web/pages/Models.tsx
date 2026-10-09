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
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

export function Models() {
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
    setNotice(provider.configured ? "全部场景已改用 OpenAI 兼容接口" : "已改用 OpenAI 兼容，但还没填密钥——生成会退回本地草稿");
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
          <p className="eyebrow">墨兰写作 · 设置</p>
          <h1>模型</h1>
          <p className="sub">密钥加密存本机数据库，接口只回尾号提示；也可用环境变量 MOLAN_API_KEY（优先）。勿把 Base URL 指到陌生域名，已保存的密钥不会发往白名单外的地址。</p>
        </div>
      </header>
      {error ? <p className="alert">{error}</p> : null}
      {notice ? <p className="form-notice">{notice}</p> : null}
      {!provider.configured && routes.some((route) => route.provider === "openai") ? (
        <p className="callout warn">
          有场景已切到 OpenAI 兼容，但还没填 API Key。现在会退回本地草稿。在下面的「接口」里保存 Base URL 和密钥即可。
        </p>
      ) : null}
      {!provider.configured && routes.every((route) => route.provider !== "openai") ? (
        <p className="callout">
          当前全部场景走本地草稿引擎，适合起稿。接上兼容接口后，选区改写和正文生成会明显更稳。
        </p>
      ) : null}


      {runtime ? (
        <section className="panel runtime-card">
          <div className="provider-head">
            <div>
              <h2>写作运行时</h2>
              <p>当前可用的适配器。已安装 @earendil-works/pi-agent-core 时可在路由或 MOLAN_AGENT_RUNTIME=pi（兼容 CHANGJUAN_AGENT_RUNTIME）启用。</p>
            </div>
            {runtime.envRuntime ? <span className="pill">env: {runtime.envRuntime}</span> : <span className="pill">按场景路由</span>}
          </div>
          <ul className="runtime-list">
            {runtime.capabilities.map((cap) => (
              <li key={cap.id} className={cap.available ? "on" : "off"}>
                <strong>{cap.label}</strong>
                <span>{cap.available ? "可用" : "不可用"}</span>
                <p>{cap.reason}</p>
              </li>
            ))}
          </ul>
          <p className="muted runtime-note">{runtime.note}</p>
        </section>
      ) : null}

      <section className="panel provider-card">
        <div className="provider-head">
          <div>
            <h2>接口</h2>
            <p>OpenAI 以及 DeepSeek、SiliconFlow、Moonshot 这类兼容接口。</p>
          </div>
          <span className={provider.configured ? "pill on" : "pill"}>{provider.configured ? "已配置" : "未配置"}</span>
        </div>
        <div className="presets" role="group" aria-label="接口预设">
          {PRESETS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={preset === item.id ? "chip on" : "chip"}
              onClick={() => pickPreset(item.id)}
            >
              {item.name}
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
                {showKey ? "隐藏" : "显示"}
              </button>
            </span>
          </label>
          <label>
            默认模型
            <ModelPicker
              value={defaultModel}
              models={models.models}
              placeholder="gpt-4o-mini / deepseek-chat"
              onChange={setDefaultModel}
            />
          </label>
        </div>
        <div className="model-meta">
          <span>{models.error ? `列表：${models.error}` : `已缓存 ${models.models.length} 个模型`}</span>
          <span>·</span>
          <span>{formatFetched(models.fetchedAt)}</span>
          <button type="button" className="text-link" disabled={busy !== ""} onClick={() => void refresh()}>
            {busy === "models" ? "刷新中…" : "刷新模型"}
          </button>
        </div>
        <div className="actions">
          <button type="button" className="btn primary" disabled={busy !== ""} onClick={() => void saveProvider()}>
            {busy === "save" ? "保存中…" : "保存接口"}
          </button>
          <button type="button" className="btn" disabled={busy !== "" || !provider.hasApiKey} onClick={() => void clearKey()}>
            清除密钥
          </button>
          <button type="button" className="btn" disabled={busy !== ""} onClick={() => void test()}>
            {busy === "test" ? "测试中…" : "测试连接"}
          </button>
        </div>
      </section>

      <section className="route-section">
        <div className="route-head">
          <div>
            <h2>场景路由</h2>
            <p>正文、审核、全书大纲、细纲等可各自选不同模型和思考强度。留空接口地址用上面的 Base URL；模型选「使用默认模型」则跟默认模型走。思考强度会映射到推理力度 / 温度；不支持的接口会降级为提示词约束。</p>
          </div>
          <div className="actions">
            <button type="button" className="btn" disabled={busy !== ""} onClick={() => void useOpenAI()}>
              全部场景改用 OpenAI 兼容
            </button>
            <button type="button" className="btn" disabled={busy !== ""} onClick={() => void useLocal()}>
              全部改回本地
            </button>
            <button type="button" className={routesDirty ? "btn primary" : "btn"} disabled={!routesDirty || busy !== ""} onClick={() => void saveRoutes()}>
              {busy === "routes" ? "保存中…" : routesDirty ? "保存路由" : "路由已保存"}
            </button>
          </div>
        </div>
        <div className="panel route-list">
          <div className="route-row head">
            <span>场景</span>
            <span>来源</span>
            <span>模型</span>
            <span>思考强度</span>
            <span>接口地址</span>
          </div>
          {ORDER.map(([scene, label, hint]) => {
            const route = routes.find((item) => item.scene === scene);
            if (!route) return null;
            const remote = route.provider === "openai";
            return (
              <div className="route-row" key={scene}>
                <div className="route-name">
                  <strong>{label}</strong>
                  <span className="route-hint">{hint}</span>
                </div>
                <select value={route.provider} aria-label={`${label}来源`} onChange={(e) => update(scene, { provider: e.target.value })}>
                  <option value="local">本地草稿</option>
                  <option value="openai">OpenAI 兼容</option>
                </select>
                {remote ? (
                  <ModelPicker
                    value={route.modelId === "local-draft" ? "" : route.modelId}
                    models={models.models}
                    placeholder="默认模型 / 自定义"
                    allowEmpty
                    emptyLabel="使用默认模型"
                    onChange={(value) => update(scene, { modelId: value || "local-draft" })}
                  />
                ) : (
                  <input value="local-draft" disabled aria-label={`${label}模型`} />
                )}
                <select
                  value={route.thinkingIntensity ?? "medium"}
                  aria-label={`${label}思考强度`}
                  title="思考强度：关闭 / 低 / 中 / 高"
                  onChange={(e) => update(scene, { thinkingIntensity: e.target.value as ThinkingIntensity })}
                >
                  {THINKING_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <input
                  value={route.baseUrl ?? ""}
                  aria-label={`${label}接口地址`}
                  placeholder={remote ? "留空则用共用地址" : "本地不需要"}
                  disabled={!remote}
                  spellCheck={false}
                  onChange={(e) => update(scene, { baseUrl: e.target.value.trim() ? e.target.value : null })}
                />
              </div>
            );
          })}
        </div>
      </section>
      <section className="card usage-card" aria-label="API 用量">
        <header className="card-head">
          <h2>用量与费用</h2>
          <button
            type="button"
            className="btn small ghost"
            onClick={() => {
              void api.usageSummary().then(setUsage).catch(() => setUsage(null));
            }}
          >
            刷新
          </button>
        </header>
        {!usage ? (
          <p className="muted">还没有调用记录。接上模型后会按次估算 token 与费用。</p>
        ) : (
          <>
            <div className="usage-stats">
              <div><strong>{usage.calls}</strong><span>次调用</span></div>
              <div><strong>{usage.totalTokens.toLocaleString("zh-CN")}</strong><span>tokens</span></div>
              <div><strong>${usage.estimatedCost.toFixed(4)}</strong><span>估算费用</span></div>
              <div><strong>{usage.localCalls}</strong><span>本地草稿</span></div>
            </div>
            {usage.byModel.length ? (
              <div className="usage-tables">
                <h3>按模型</h3>
                <ul>
                  {usage.byModel.slice(0, 8).map((row) => (
                    <li key={row.model}>
                      <span>{row.model}</span>
                      <span>{row.calls} 次 · {row.totalTokens} tok · ${row.estimatedCost.toFixed(4)}</span>
                    </li>
                  ))}
                </ul>
                <h3>按书</h3>
                <ul>
                  {usage.byBook.slice(0, 8).map((row) => (
                    <li key={row.bookId ?? "none"}>
                      <span>{row.title}</span>
                      <span>{row.calls} 次 · ${row.estimatedCost.toFixed(4)}</span>
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
