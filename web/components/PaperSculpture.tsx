import type { CSSProperties } from "react";

/** A CSS-rendered paper object: no image payload, no WebGL loop, no input interception. */
export function PaperSculpture() {
  return <div className="paper-art" aria-hidden="true">
    <div className="art-coordinate top">FIG. 01 — THE UNWRITTEN</div>
    <div className="art-axis x" /><div className="art-axis y" />
    <div className="paper-shadow" />
    <div className="paper-orbit">
      <div className="paper-fan">{Array.from({ length: 19 }, (_, index) => <div
        className="paper-leaf" key={index}
        style={{ "--leaf": index, "--leaf-angle": `${(index-9)*5.7}deg`, "--leaf-lift": `${index*1.15}px` } as CSSProperties}
      ><div className="leaf-type">{index % 3 === 0 ? "未" : index % 3 === 1 ? "写" : "完"}</div><div className="leaf-lines" /><span className="leaf-folio">MOLAN / {String(index+1).padStart(2,"0")}</span></div>)}</div>
    </div>
    <div className="art-coordinate bottom"><span>WORDS BECOME WORLDS</span><span>01 / ∞</span></div>
  </div>;
}
