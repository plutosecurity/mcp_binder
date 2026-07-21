const SNAP_BACK_DRAG_THRESHOLD = 5;
const SNAP_BACK_RETURN_MS = 280;

export function attachSnapBackInteractions(options = {}) {
  const root = options.root || document;
  const documentRef = root.ownerDocument || document;
  const windowRef = documentRef.defaultView || window;
  const selector = options.selector || defaultSnapBackSelector();
  const exclude = options.exclude || defaultSnapBackExclude;
  let active = null;

  function refresh(scope = root) {
    if (scope.matches?.(selector) && !exclude(scope)) {
      scope.classList.add("snapBackInteractive");
    }

    for (const element of scope.querySelectorAll(selector)) {
      if (exclude(element)) {
        continue;
      }
      element.classList.add("snapBackInteractive");
    }
  }

  function start(event) {
    if (event.button !== 0 || active) {
      return;
    }

    const target = event.target.closest(".snapBackInteractive");
    if (!target || exclude(target)) {
      return;
    }

    active = {
      target,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false
    };
    target.classList.remove("snapBackReturning");
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // Some elements cannot capture pointer events in all browser states.
    }
    target.addEventListener("pointermove", move);
  }

  function move(event) {
    if (!active) {
      return;
    }

    const rawX = event.clientX - active.startX;
    const rawY = event.clientY - active.startY;
    if (Math.hypot(rawX, rawY) < SNAP_BACK_DRAG_THRESHOLD && !active.moved) {
      return;
    }

    active.moved = true;
    active.target.classList.add("snapBackDragging");
    active.target.style.setProperty("--snap-x", `${rawX}px`);
    active.target.style.setProperty("--snap-y", `${rawY}px`);
    active.target.style.setProperty("--snap-rotate", `${clamp(rawX / 28, -3, 3)}deg`);
  }

  function finishSnapBackInteraction(event) {
    if (!active) {
      return;
    }

    const { target, moved, pointerId } = active;
    active = null;
    try {
      if (pointerId !== undefined && target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
    } catch {
      // Pointer capture can already be gone after context menus or tab changes.
    }
    target.removeEventListener("pointermove", move);

    if (!moved) {
      return;
    }

    if (event?.type === "contextmenu") {
      event.preventDefault();
    }
    target.dataset.snapBackMoved = "true";
    target.classList.remove("snapBackDragging");
    target.classList.add("snapBackReturning");
    target.style.setProperty("--snap-x", "0px");
    target.style.setProperty("--snap-y", "0px");
    target.style.setProperty("--snap-rotate", "0deg");
    windowRef.setTimeout(() => {
      delete target.dataset.snapBackMoved;
      target.classList.remove("snapBackReturning");
      target.style.removeProperty("--snap-x");
      target.style.removeProperty("--snap-y");
      target.style.removeProperty("--snap-rotate");
    }, SNAP_BACK_RETURN_MS);
  }

  function suppressClick(event) {
    const target = event.target.closest(".snapBackInteractive");
    if (!target?.dataset?.snapBackMoved) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  }

  refresh(root);
  documentRef.addEventListener("pointerdown", start, true);
  documentRef.addEventListener("pointerup", finishSnapBackInteraction, true);
  documentRef.addEventListener("pointercancel", finishSnapBackInteraction, true);
  documentRef.addEventListener("contextmenu", finishSnapBackInteraction, true);
  documentRef.addEventListener("click", suppressClick, true);
  documentRef.addEventListener("visibilitychange", () => finishSnapBackInteraction(), true);
  windowRef.addEventListener("blur", () => finishSnapBackInteraction(), true);

  return {
    refresh,
    finish: finishSnapBackInteraction
  };
}

function defaultSnapBackSelector() {
  return [
    "button",
    ".brandTitle",
    ".githubLink",
    ".statusButton",
    ".badge",
    ".verdict",
    ".form",
    ".panel",
    ".summary > div",
    ".finding",
    ".blockedScan",
    ".detail",
    ".detailSection",
    ".toolItem",
    ".operatorDialogFacts > div"
  ].join(",");
}

function defaultSnapBackExclude(element) {
  return Boolean(
    element.closest(".activityPanel")
    || element.closest(".operatorNotice")
    || element.closest("select")
    || element.closest("input")
    || element.closest("textarea")
    || element.closest("pre")
    || element.closest("code")
    || element.closest("[data-no-snap]")
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
