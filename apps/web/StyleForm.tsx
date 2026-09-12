import React, { useState } from "react";
import { normalizedXianxiaDna } from "../../packages/visual-style";
import { templates as defaultCatalog } from "../../packages/domain";

type StyleCard = (typeof defaultCatalog)[number] & { version?: string };

export function StyleForm({
  current,
  focus,
  busy,
  onSubmit,
  catalog = defaultCatalog,
  applied,
  images = [],
  onReference,
}: {
  current: string;
  focus?: string;
  busy: boolean;
  onSubmit: (id: string) => void;
  catalog?: StyleCard[];
  applied?: {
    id: string;
    prompt: string;
    version?: string;
    productionPrompt?: string;
    referenceImageId?: string;
    characterModule?: string;
    propModule?: string;
    sceneModule?: string;
  };
  images?: { id: string; name: string }[];
  onReference?: (id: string) => void;
}) {
  const initial =
    catalog.find((t) => t.id === (focus || current)) || catalog[0];
  const [shownId, setShownId] = useState(initial.id);
  const [picking, setPicking] = useState(false);
  const shown = catalog.find((t) => t.id === shownId) || initial;
  const inForce = applied?.id === shown.id;
  const promptText = normalizedXianxiaDna(inForce && applied?.prompt ? applied.prompt : shown.prompt);
  const stale = inForce && applied?.prompt && normalizedXianxiaDna(applied.prompt) !== applied.prompt;
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
          仙侠模板中的通用服装默认值已移除；新的图片使用下方统一画风，人物衣着仍由各自设定决定。
        </p>
      )}
      <h3 className="style-prompt-title">
        {inForce ? "当前作品正在用于生成的说明" : "生成时使用的画风说明"}
      </h3>
      <p className="muted">
        每张图使用同一套全局画风，人物内容与单图调整不能覆盖它。不同衣着共用这套造型语言、材质和布光。绑定的美术参考只锁渲染，不锁衣服、年龄或五官。
      </p>
      <pre className="style-prompt">{promptText}</pre>
      {inForce && applied?.characterModule && (
        <>
          <details>
            <summary>人物模块</summary>
            <pre className="style-prompt">{applied.characterModule}</pre>
          </details>
          <details>
            <summary>道具模块</summary>
            <pre className="style-prompt">{applied.propModule}</pre>
          </details>
          <details>
            <summary>场景模块</summary>
            <pre className="style-prompt">{applied.sceneModule}</pre>
          </details>
        </>
      )}
      {inForce && applied?.productionPrompt && applied.productionPrompt !== promptText && (
        <details>
          <summary>共用制作风格（场景、道具与剧情镜头）</summary>
          <pre className="style-prompt">{normalizedXianxiaDna(applied.productionPrompt)}</pre>
        </details>
      )}
      {inForce && onReference && <label>作品美术参考
        <select disabled={busy} value={applied?.referenceImageId || ""} onChange={e => onReference(e.target.value)}>
          <option value="">尚未绑定参考图</option>
          {images.map(file => <option key={file.id} value={file.id}>{file.name}</option>)}
        </select>
        {applied?.referenceImageId && <img alt="作品美术参考" src={`/api/media/files/${applied.referenceImageId}`} style={{maxWidth: "100%", maxHeight: 240, objectFit: "contain"}} />}
      </label>}

      <div className="button-group">
        {shown.id !== current && (
          <button
            className="button primary"
            disabled={busy}
            onClick={() => onSubmit(shown.id)}
          >
            应用到当前作品
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
