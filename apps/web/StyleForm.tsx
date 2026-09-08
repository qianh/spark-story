import React, { useState } from "react";
import { templates as defaultCatalog } from "../../packages/domain";

type StyleCard = (typeof defaultCatalog)[number] & { version?: string };

export function StyleForm({
  current,
  focus,
  busy,
  onSubmit,
  catalog = defaultCatalog,
  applied,
}: {
  current: string;
  focus?: string;
  busy: boolean;
  onSubmit: (id: string) => void;
  catalog?: StyleCard[];
  applied?: { id: string; prompt: string; version?: string };
}) {
  const initial =
    catalog.find((t) => t.id === (focus || current)) || catalog[0];
  const [shownId, setShownId] = useState(initial.id);
  const [picking, setPicking] = useState(false);
  const shown = catalog.find((t) => t.id === shownId) || initial;
  const inForce = applied?.id === shown.id;
  const stale =
    inForce && applied?.prompt && applied.prompt !== shown.prompt;
  const promptText = inForce && applied?.prompt ? applied.prompt : shown.prompt;
  if (picking)
    return (
      <>
        <p className="eyebrow">VISUAL DIRECTION</p>
        <h2>更换画风</h2>
        <p>
          切换后会重做定妆及之后的画面，剧本和文字分镜保留。旧图作为历史版本保留。画风决定造型与渲染方式，角色身份、服饰和场景由作品设定决定。
        </p>
        <div className="style-picker">
          {catalog.map((t) => (
            <button
              key={t.id}
              className={"style-option" + (t.id === shownId ? " selected" : "")}
              disabled={busy}
              onClick={() => {
                setShownId(t.id);
                setPicking(false);
              }}
            >
              <strong>{t.name}</strong>
              <small>{t.en}</small>
              <p>{t.description}</p>
            </button>
          ))}
        </div>
      </>
    );
  return (
    <>
      <p className="eyebrow">VISUAL DIRECTION</p>
      <h2>{shown.name}</h2>
      <p className="style-detail-kicker">{shown.en}</p>
      <p>{shown.description}</p>
      {shown.id === current ? (
        <span className="tag">当前作品画风</span>
      ) : (
        <p className="muted">尚未应用到当前作品。应用后会按此说明重做定妆及之后的画面。</p>
      )}
      {stale && (
        <p className="muted">
          下面是当前作品锁定的生成说明。模板文本已更新，重新应用后才会用于新的定妆。
        </p>
      )}
      <h3 className="style-prompt-title">
        {inForce ? "当前作品正在用于生成的说明" : "生成时使用的画风说明"}
      </h3>
      <p className="muted">
        定妆、关键帧和视频都只使用作品里锁定的这一份说明，不使用前端包里另一份副本。角色是谁、穿什么、本集什么状态，仍由资产设定决定。画风相同不代表角色外貌、年龄或服装相同。
      </p>
      <pre className="style-prompt">{promptText}</pre>
      <div className="button-group">
        {(shown.id !== current || stale) && (
          <button
            className="button primary"
            disabled={busy}
            onClick={() => onSubmit(shown.id)}
          >
            {stale ? "按当前模板重新应用" : "应用到当前作品"}
          </button>
        )}
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => setPicking(true)}
        >
          更换其他画风
        </button>
      </div>
    </>
  );
}
