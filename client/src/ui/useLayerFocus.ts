import { useLayoutEffect, useRef, type RefObject } from "react";

type Layer = { readonly root: HTMLElement; readonly modal: boolean };
const layers: Layer[] = [];
const selector = 'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((node) => {
    const style = getComputedStyle(node);
    return !node.closest("[hidden], [inert]") && style.display !== "none" && style.visibility !== "hidden";
  });
}

/** Focus lifecycle for stacked modal and non-modal panels. */
export function useLayerFocus({ open, container, initialFocus, modal = false, onClose }: {
  readonly open: boolean;
  readonly container: RefObject<HTMLElement>;
  readonly initialFocus?: RefObject<HTMLElement>;
  readonly modal?: boolean;
  readonly onClose?: (() => void) | undefined;
}) {
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const root = container.current;
    if (!open || !root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const layer: Layer = { root, modal };
    layers.push(layer);
    const inerted: { node: HTMLElement; wasInert: boolean }[] = [];
    if (modal) {
      let branch: HTMLElement = root;
      while (branch.parentElement) {
        for (const sibling of branch.parentElement.children) {
          if (sibling !== branch && sibling instanceof HTMLElement) {
            inerted.push({ node: sibling, wasInert: sibling.hasAttribute("inert") });
            sibling.setAttribute("inert", "");
          }
        }
        if (branch.parentElement === document.body) break;
        branch = branch.parentElement;
      }
    }
    const focusFirst = () => (initialFocus?.current ?? focusableElements(root)[0] ?? root).focus({ preventScroll: true });
    focusFirst();
    const onKeyDown = (event: KeyboardEvent) => {
      if (layers.at(-1) !== layer || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape" && close.current) {
        event.preventDefault(); event.stopImmediatePropagation(); close.current();
      } else if (event.key === "Tab" && modal) {
        const nodes = focusableElements(root), first = nodes[0], last = nodes.at(-1);
        if (!first || !last) { event.preventDefault(); root.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (modal && layers.at(-1) === layer && !root.contains(event.target as Node)) focusFirst();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocus);
    return () => {
      const index = layers.indexOf(layer), wasTop = index === layers.length - 1;
      if (index >= 0) layers.splice(index, 1);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocus);
      for (const { node, wasInert } of inerted) if (!wasInert) node.removeAttribute("inert");
      if (wasTop && previous?.isConnected && !previous.closest("[inert]")) previous.focus({ preventScroll: true });
    };
  }, [open, container, initialFocus, modal]);
}
