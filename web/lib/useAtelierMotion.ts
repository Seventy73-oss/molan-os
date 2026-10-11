import { useEffect, useRef } from "react";

/** Local, progressive motion. Never intercepts scrolling or moves writing controls. */
export function useAtelierMotion() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const fine = matchMedia("(pointer: fine)");
    let frame = 0;
    let active: HTMLElement | null = null;
    let x = 0, y = 0, tx = 0, ty = 0, vx = 0, vy = 0;
    let last = 0;
    const step = (time: number) => {
      frame = 0;
      const dt = Math.min((time - (last || time - 16)) / 1000, .032);
      last = time;
      vx += ((tx - x) * 180 - vx * 22) * dt;
      vy += ((ty - y) * 180 - vy * 22) * dt;
      x += vx * dt; y += vy * dt;
      active?.style.setProperty("--pointer-x", x.toFixed(3));
      active?.style.setProperty("--pointer-y", y.toFixed(3));
      if (Math.abs(tx-x)+Math.abs(ty-y)+Math.abs(vx)+Math.abs(vy) > .004) frame = requestAnimationFrame(step);
    };
    const move = (event: PointerEvent) => {
      if (!fine.matches || reduced.matches || event.pointerType === "touch") return;
      const target = (event.target as Element).closest<HTMLElement>("[data-kinetic]");
      if (target !== active) {
        active?.style.setProperty("--pointer-x", "0"); active?.style.setProperty("--pointer-y", "0");
        active = target; x = y = vx = vy = 0;
      }
      if (!target) return;
      const r = target.getBoundingClientRect();
      tx = Math.max(-1, Math.min(1, (event.clientX-r.x)/r.width*2-1));
      ty = Math.max(-1, Math.min(1, (event.clientY-r.y)/r.height*2-1));
      if (!frame) { last = 0; frame = requestAnimationFrame(step); }
    };
    const leave = () => { tx = ty = 0; if (!frame) { last=0; frame=requestAnimationFrame(step); } };
    const resetMotion = () => {
      cancelAnimationFrame(frame); frame = 0;
      x = y = tx = ty = vx = vy = 0;
      active?.style.setProperty("--pointer-x", "0");
      active?.style.setProperty("--pointer-y", "0");
      active = null;
    };
    reduced.addEventListener("change", resetMotion);
    fine.addEventListener("change", resetMotion);
    const main = el.closest<HTMLElement>(".main");
    const scroll = () => {
      if (!main) return;
      el.style.setProperty("--reading-progress", String(main.scrollTop / Math.max(1, main.scrollHeight-main.clientHeight)));
    };
    el.addEventListener("pointermove", move, { passive: true });
    el.addEventListener("pointerleave", leave, { passive: true });
    main?.addEventListener("scroll", scroll, { passive: true });
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        entry.target.classList.add("is-revealed"); observer.unobserve(entry.target);
      }
    }, { root: main, threshold: .05 });
    const watch = () => el.querySelectorAll(".reveal:not(.is-revealed)").forEach(node => observer.observe(node));
    watch();
    const mutation = new MutationObserver(watch);
    mutation.observe(el, { childList: true, subtree: true });
    el.dataset.motion = "ready";
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); mutation.disconnect();
      reduced.removeEventListener("change", resetMotion);
      fine.removeEventListener("change", resetMotion);
      el.removeEventListener("pointermove", move); el.removeEventListener("pointerleave", leave);
      main?.removeEventListener("scroll", scroll);
    };
  }, []);
  return root;
}
