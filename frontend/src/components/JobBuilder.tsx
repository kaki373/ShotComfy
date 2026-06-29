import { useEffect, useMemo, useState } from "react";
import {
  assetUrl,
  getWorkflows,
  openWorkflowsFolder,
  runJobs,
  type AssetT,
  type JobSpec,
  type PromptOverride,
  type PromptSlot,
  type QueueResp,
  type WorkflowInfo,
} from "../api";

export interface SelItem {
  asset: AssetT;
  boardId: string;
}
interface JobRow {
  cells: (SelItem | null)[]; // one per slot, in slot order
}

interface Props {
  open: boolean;
  onClose: () => void;
  selected: SelItem[]; // live canvas selection, in click order
  onDone: (boardIds: string[]) => void;
  showNotice: (m: string) => void;
}

const boardLabel = (id: string) => (id === "." || id === "" ? "（ルート）" : id);
const slotIcon = (kind: string) => (kind === "video" ? "🎬" : "🖼");

// turn a backend result error into a readable one-liner (esp. ComfyUI node_errors)
function errorSummary(r: { error?: string; detail?: unknown }): string {
  if (!r.error) return "";
  if (r.error === "node_errors" && r.detail && typeof r.detail === "object") {
    const parts: string[] = [];
    for (const [nid, info] of Object.entries(r.detail as Record<string, any>)) {
      const ct = info?.class_type ?? nid;
      const msgs = (info?.errors ?? [])
        .map((e: any) => e.details || e.message)
        .filter(Boolean)
        .join(", ");
      parts.push(`${ct}(#${nid})${msgs ? `: ${msgs}` : ""}`);
    }
    return `ノードエラー — ${parts.join(" / ")}`;
  }
  return r.error;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function Thumb({ item, size }: { item: SelItem; size: number }) {
  return (
    <div className="jb-t" style={{ width: size, height: size }} title={`${item.asset.name}\n${boardLabel(item.boardId)}`}>
      {item.asset.kind === "image" ? (
        <img src={assetUrl(item.asset.path)} alt="" />
      ) : (
        <span className="jb-t-vid">{item.asset.kind === "video" ? "🎬" : "📄"}</span>
      )}
    </div>
  );
}

export default function JobBuilder({ open, onClose, selected, onDone, showNotice }: Props) {
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [wfName, setWfName] = useState("");
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [resp, setResp] = useState<QueueResp | null>(null);
  const [repeat, setRepeat] = useState(1);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptEdits, setPromptEdits] = useState<Record<string, { text: string; mode: "prepend" | "append" | "replace"; override: boolean }>>({});

  const loadWorkflows = (notify = false) => {
    getWorkflows()
      .then((ws) => {
        setWorkflows(ws);
        setWfName((cur) => {
          if (ws.some((w) => w.name === cur)) return cur;
          // a UI workflow that just got auto-converted -> switch to its _api version
          const sibling = ws.find((w) => w.name === `${cur}_api`);
          if (sibling) return sibling.name;
          return (ws.find((w) => w.api && w.slots.length) ?? ws.find((w) => w.api) ?? ws[0])?.name ?? "";
        });
        if (notify) showNotice(`ワークフロー ${ws.length} 件を読み込みました`);
      })
      .catch(() => {
        if (notify) showNotice("ワークフロー一覧の取得に失敗しました");
      });
  };

  useEffect(() => {
    if (open) loadWorkflows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // while a UI-format workflow is pending auto-conversion, poll so its _api appears on its own
  const hasPending = workflows.some((w) => !w.api);
  useEffect(() => {
    if (!open || !hasPending) return;
    const t = setInterval(() => loadWorkflows(), 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasPending]);

  const wf = useMemo(() => workflows.find((w) => w.name === wfName), [workflows, wfName]);
  const slots = wf?.slots ?? [];
  const slotCount = slots.length;
  const perJob = slotCount || 1; // images consumed per job (auto from workflow)
  const willMake = Math.ceil(selected.length / perJob);

  // add the current selection (in click order) as new jobs, chunked by the slot count
  const addJobs = () => {
    if (!selected.length) return;
    const groups = chunk(selected, perJob);
    setJobs((prev) => [...prev, ...groups.map((g) => ({ cells: slots.map((_, k) => g[k] ?? null) }))]);
  };
  const removeJob = (i: number) => setJobs((prev) => prev.filter((_, k) => k !== i));
  const clearJobs = () => setJobs([]);

  const buildPromptOverrides = (): PromptOverride[] => {
    const overrides: PromptOverride[] = [];
    for (const [nodeId, edit] of Object.entries(promptEdits)) {
      if (edit.text.trim()) {
        overrides.push({
          node_id: nodeId,
          mode: edit.mode,
          text: edit.text,
          override_connection: edit.override,
        });
      }
    }
    return overrides;
  };

  const submittable = jobs.filter((j) => j.cells[0]); // need at least the first (output) image
  const submit = async () => {
    if (!wf || !submittable.length) return;
    setBusy(true);
    setResp(null);
    try {
      const base: JobSpec[] = submittable.map((j) => {
        const sl: Record<string, string> = {};
        slots.forEach((s, k) => {
          if (j.cells[k]) sl[s.node_id] = j.cells[k]!.asset.path;
        });
        return { board_id: j.cells[0]!.boardId, slots: sl };
      });
      const payload: JobSpec[] = [];
      for (let i = 0; i < repeat; i++) payload.push(...base);
      const overrides = buildPromptOverrides();
      const r = await runJobs(wf.name, payload, overrides.length ? overrides : undefined);
      setResp(r);
      onDone([...new Set(submittable.map((j) => j.cells[0]!.boardId))]);
      const ok = r.results.filter((x) => !x.error).length;
      showNotice(`生成完了：${ok}/${r.results.length} ジョブ成功`);
    } catch (e) {
      setResp({ workflow: wf.name, results: [{ board: "?", error: String(e) }] });
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="jb">
      <div className="jb-head">
        <span>▶ ComfyUI ジョブ</span>
        <button className="jb-x" onClick={onClose}>
          ✕
        </button>
      </div>

      {/* workflow */}
      <div className="jb-field">
        <span>ワークフロー</span>
        <div className="jb-wfrow">
          <select
            className="jb-wfsel"
            value={wfName}
            onChange={(e) => {
              setWfName(e.target.value);
              clearJobs();
              setResp(null);
            }}
          >
            {workflows.length === 0 && <option>（ワークフロー無し）</option>}
            {workflows.map((w) => (
              <option key={w.name} value={w.name}>
                {w.name}
              </option>
            ))}
          </select>
          <button
            className="jb-reload"
            onClick={() => openWorkflowsFolder().catch(() => {})}
            title="workflows フォルダをエクスプローラで開く"
          >
            📁
          </button>
          <button
            className="jb-reload"
            onClick={() => loadWorkflows(true)}
            title="workflows フォルダを再スキャンして一覧を更新"
          >
            ⟳
          </button>
        </div>
      </div>

      {/* UI-format workflow: auto-converted in the background to <name>_api */}
      {wf && !wf.api && (
        <div className="jb-pending">
          ⏳ ComfyUIでAPI化中… ComfyUIのタブを開いておくと自動変換され「{wfName}_api」が出てきます。
        </div>
      )}

      {wf && wf.api && slotCount === 0 && (
        <div className="jb-warn">このワークフローには画像入力スロットがありません。</div>
      )}

      {wf && wf.api && slotCount > 0 && (
        <>
          <div className="jb-slotline">
            画像入力 <b>{slotCount}</b> スロット（{slots.map((s) => `${slotIcon(s.kind)}${s.title}`).join(" ")}）
            ＝ 1ジョブ {slotCount} 枚
          </div>

          {/* STEP 1 — current canvas selection, always visible */}
          <div className="jb-step">① キャンバスで画像を選択</div>
          <div className="jb-selbox">
            {selected.length === 0 ? (
              <div className="jb-selempty">画像ノードをクリック（複数は Shift＋クリック / Shift＋ドラッグ）</div>
            ) : (
              <>
                <div className="jb-selstrip">
                  {selected.map((it, i) => (
                    <div key={it.asset.path + i} className="jb-selitem">
                      <Thumb item={it} size={46} />
                      <span className="jb-seln">{i + 1}</span>
                    </div>
                  ))}
                </div>
                <div className="jb-selcount">{selected.length} 枚選択中</div>
              </>
            )}
          </div>

          {/* Prompt override */}
          <button
            className={`jb-prompt-toggle${promptOpen ? " on" : ""}${Object.values(promptEdits).some(e => e.text.trim()) ? " has-edits" : ""}`}
            onClick={() => setPromptOpen(p => !p)}
          >
            ✏ プロンプト {promptOpen ? "▲" : "▼"}
          </button>
          {promptOpen && wf && (
            <div className="jb-prompt-panel">
              {(wf.prompt_slots ?? []).length === 0 ? (
                <div className="jb-empty">このワークフローにプロンプトスロットが見つかりません</div>
              ) : (
                (wf.prompt_slots ?? []).map((ps: PromptSlot) => {
                  const key = ps.node_id;
                  const edit = promptEdits[key] ?? { text: "", mode: "append" as const, override: false };
                  const setEdit = (patch: Partial<typeof edit>) =>
                    setPromptEdits(prev => ({ ...prev, [key]: { ...edit, ...patch } }));
                  return (
                    <div key={key} className="jb-prompt-slot">
                      <div className="jb-prompt-head">
                        <span className={`jb-prompt-role ${ps.role}`}>{ps.role === "positive" ? "＋" : "−"}</span>
                        <span className="jb-prompt-title">{ps.title}</span>
                        {ps.connected && <span className="jb-prompt-conn" title="他ノードから接続">🔗</span>}
                      </div>
                      {ps.text && <div className="jb-prompt-preview">{ps.text}</div>}
                      <textarea
                        className="jb-prompt-input"
                        placeholder="追加プロンプト…"
                        value={edit.text}
                        onChange={e => setEdit({ text: e.target.value })}
                        rows={2}
                      />
                      <div className="jb-prompt-opts">
                        <select value={edit.mode} onChange={e => setEdit({ mode: e.target.value as "prepend" | "append" | "replace" })}>
                          <option value="prepend">先頭に追加</option>
                          <option value="append">末尾に追加</option>
                          <option value="replace">置換</option>
                        </select>
                        {ps.connected && (
                          <label className="jb-prompt-ovr">
                            <input type="checkbox" checked={edit.override} onChange={e => setEdit({ override: e.target.checked })} />
                            LLM出力を上書き
                          </label>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* STEP 2 — add to jobs */}
          <button className="jb-add" disabled={selected.length === 0} onClick={addJobs}>
            ＋ ジョブに追加
            {selected.length > 0 && (
              <span className="jb-addsub">
                {selected.length}枚 → {willMake}ジョブ
              </span>
            )}
          </button>

          {/* job list */}
          {jobs.length > 0 && (
            <>
              <div className="jb-step">
                ② ジョブ {jobs.length} 件
                <button className="jb-clear" onClick={clearJobs}>
                  全消去
                </button>
              </div>
              <div className="jb-joblist">
                {jobs.map((j, i) => (
                  <div key={i} className={`jb-jrow ${j.cells[0] ? "" : "noaxis"}`}>
                    <span className="jb-jn">#{i + 1}</span>
                    <div className="jb-jcells">
                      {slots.map((s, k) => (
                        <div key={s.node_id} className="jb-jcell">
                          {k > 0 && <span className="jb-plus">＋</span>}
                          {j.cells[k] ? (
                            <Thumb item={j.cells[k]!} size={40} />
                          ) : (
                            <span className="jb-jmiss">なし</span>
                          )}
                          <span className="jb-jtag">{s.title}</span>
                        </div>
                      ))}
                    </div>
                    <span className="jb-jout">→ {boardLabel(j.cells[0]?.boardId ?? "?")}</span>
                    <button className="jb-jdel" onClick={() => removeJob(i)} title="削除">
                      ✕
                    </button>
                  </div>
                ))}
              </div>

              {/* STEP 3 — submit */}
              <div className="jb-step">③ 投入</div>
              <div className="jb-namehint">出力名：入力ファイル名 + <b>_gen1</b>（再生成は _gen2, _gen3…）</div>
              <div className="jb-repeat">
                <label>繰り返し</label>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={repeat}
                  onChange={(e) => setRepeat(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                />
                <span>回</span>
              </div>
              <button className="jb-go" disabled={busy || submittable.length === 0} onClick={submit}>
                {busy ? "生成中…" : `${submittable.length * repeat} ジョブを ComfyUI に投入`}
              </button>
            </>
          )}
        </>
      )}

      {resp && (
        <div className="jb-results">
          {resp.results.map((r, i) => (
            <div key={i} className={`jb-res ${r.error ? "err" : "ok"}`}>
              {r.error
                ? `✕ ${boardLabel(r.board)}: ${errorSummary(r)}`
                : `✓ ${boardLabel(r.board)} (${r.outputs?.length ?? 0}枚)`}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
