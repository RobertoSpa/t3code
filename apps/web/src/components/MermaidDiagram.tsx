import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import type { MermaidConfig, RenderResult } from "mermaid";
import { Dialog, DialogPopup, DialogTitle } from "./ui/dialog";

export type MermaidTheme = "light" | "dark";

interface DiagramRequest {
  id: string;
  code: string;
  theme: MermaidTheme;
  cacheKey: string;
  /** Any node inside the themed subtree; the palette is read from it. */
  element: Element | null;
}

interface DiagramRender {
  svg: string;
  /** Painted behind the diagram so the edge-label chips blend into it. */
  surface: string;
}

const DIAGRAM_CACHE_MAX = 50;
const OBSERVER_ROOT_MARGIN = "400px";
const diagramCache = new Map<string, DiagramRender>();

// Mermaid configuration is global, so initialization and rendering must stay paired.
let renderQueue = Promise.resolve();

// Mermaid derives shades with a color library that cannot parse `oklch()`, so
// every token is resolved to hex first.
// Node fill and diagram surface come from diagramPalette, not from this table.
const THEME_VARIABLE_SOURCES: ReadonlyArray<readonly [string, string]> = [
  ["primaryBorderColor", "--color-primary"],
  ["nodeBorder", "--color-primary"],
  ["clusterBorder", "--color-border"],
  ["primaryTextColor", "--color-foreground"],
  ["nodeTextColor", "--color-foreground"],
  ["textColor", "--color-foreground"],
  ["titleColor", "--color-foreground"],
  ["lineColor", "--color-muted-foreground"],
];

// ponytail: keyed on light/dark only, so switching theme id (grove, ocean)
// keeps a cached diagram on the old palette until reload. Key on the resolved
// background token instead if that becomes annoying.
function diagramCacheKey(theme: MermaidTheme, code: string): string {
  return `${theme}\n${code}`;
}

const UNPARSEABLE_SENTINEL = "#ff00ff";

function paintPixel(layers: readonly string[]): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) {
    return null;
  }
  for (const layer of layers) {
    context.fillStyle = UNPARSEABLE_SENTINEL;
    context.fillStyle = layer;
    context.fillRect(0, 0, 1, 1);
  }
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  if (red === undefined || green === undefined || blue === undefined) {
    return null;
  }
  const packed = (red << 16) | (green << 8) | blue;
  return `#${packed.toString(16).padStart(6, "0")}`;
}

/**
 * Nodes take the chat background and the diagram takes the raised-panel surface
 * the composer sits on, so the two stay one step apart under any theme. Both
 * tokens can be translucent, so each is flattened against the one below it.
 */
function diagramPalette(element: Element): { node: string; surface: string } | null {
  const pageToken = readCssToken(element, "--color-background");
  if (pageToken === null) {
    return null;
  }
  const node = cssColorToHex(pageToken, "#000000");
  if (node === null) {
    return null;
  }
  const raisedToken = readCssToken(element, "--surface-raised");
  if (raisedToken === null) {
    return { node, surface: node };
  }
  const surface = cssColorToHex(raisedToken, node);
  if (surface === null) {
    return { node, surface: node };
  }
  return { node, surface };
}

// Surface tokens are translucent (`color-mix(... 3%, transparent)`), so each one
// is painted over the opaque surface first. Sampling it alone yields the
// unpremultiplied source color, which for 3% white is pure white.
function cssColorToHex(value: string, backdrop: string): string | null {
  const hex = paintPixel([backdrop, value]);
  if (hex === null) {
    return null;
  }
  // An unparseable value leaves the sentinel painted.
  if (hex === UNPARSEABLE_SENTINEL) {
    return null;
  }
  return hex;
}

// Read from the diagram's own node so a theme scoped to a subtree resolves too.
function readCssToken(element: Element, name: string): string | null {
  const raw = getComputedStyle(element).getPropertyValue(name).trim();
  if (raw === "") {
    return null;
  }
  return raw;
}

function mermaidThemeVariables(element: Element): Record<string, string> {
  const palette = diagramPalette(element);
  if (palette === null) {
    return {};
  }
  // The edge-label chip matches the surface it sits on, so it stops reading as a
  // box behind the label text.
  const variables: Record<string, string> = {
    background: palette.surface,
    edgeLabelBackground: palette.surface,
    clusterBkg: palette.surface,
    mainBkg: palette.node,
    primaryColor: palette.node,
    secondaryColor: palette.node,
    tertiaryColor: palette.node,
  };
  for (const [mermaidKey, cssToken] of THEME_VARIABLE_SOURCES) {
    const raw = readCssToken(element, cssToken);
    if (raw === null) {
      continue;
    }
    const hex = cssColorToHex(raw, palette.surface);
    if (hex === null) {
      continue;
    }
    variables[mermaidKey] = hex;
  }
  return variables;
}

/** Exported for tests: the security fields must survive every theming branch. */
export function mermaidConfig(theme: MermaidTheme, element: Element | null): MermaidConfig {
  const base: MermaidConfig = {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "maxTextSize",
      "suppressErrorRendering",
      "maxEdges",
      "themeCSS",
      "fontFamily",
      "altFontFamily",
    ],
    theme: theme === "dark" ? "dark" : "default",
  };
  if (element === null) {
    return base;
  }
  const themeVariables = mermaidThemeVariables(element);
  if (Object.keys(themeVariables).length === 0) {
    return base;
  }
  const fontFamily = readCssToken(element, "--font-sans");
  if (fontFamily === null) {
    return { ...base, theme: "base", themeVariables };
  }
  return { ...base, theme: "base", themeVariables, fontFamily };
}

function diagramCacheStore(key: string, render: DiagramRender): void {
  diagramCache.delete(key);
  diagramCache.set(key, render);
  if (diagramCache.size <= DIAGRAM_CACHE_MAX) {
    return;
  }
  const oldest = diagramCache.keys().next().value;
  if (oldest === undefined) {
    return;
  }
  diagramCache.delete(oldest);
}

/** Caches a rendered diagram so a scroll remount does not render it again. Exported for tests. */
export function cacheRenderedDiagram(
  theme: MermaidTheme,
  code: string,
  render: DiagramRender,
): void {
  diagramCacheStore(diagramCacheKey(theme, code), render);
}

export function renderMermaidDiagram(
  request: DiagramRequest,
  isActive: () => boolean,
): Promise<RenderResult | null> {
  const render = async (): Promise<RenderResult | null> => {
    if (!isActive()) {
      return null;
    }
    const { default: mermaid } = await import("mermaid");
    if (!isActive()) {
      return null;
    }
    mermaid.initialize(mermaidConfig(request.theme, request.element));
    return mermaid.render(request.id, request.code);
  };

  const result = renderQueue.then(render, render);
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function observeVisibility(host: HTMLDivElement | null, onVisible: () => void): () => void {
  if (host === null) {
    return () => undefined;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) {
        return;
      }
      onVisible();
      observer.disconnect();
    },
    { rootMargin: OBSERVER_ROOT_MARGIN },
  );
  observer.observe(host);
  return () => observer.disconnect();
}

function startDiagramRender(
  request: DiagramRequest,
  onRendered: (render: DiagramRender) => void,
  onFailed: () => void,
): () => void {
  let active = true;
  void renderMermaidDiagram(request, () => active).then(
    (result) => {
      if (result === null) {
        return;
      }
      const palette = request.element === null ? null : diagramPalette(request.element);
      const render: DiagramRender = {
        svg: result.svg,
        surface: palette === null ? "transparent" : palette.surface,
      };
      diagramCacheStore(request.cacheKey, render);
      if (active) {
        onRendered(render);
      }
    },
    () => {
      if (active) {
        onFailed();
      }
    },
  );
  return () => {
    active = false;
  };
}

export function MermaidDiagram({
  code,
  theme,
  fallback,
}: {
  code: string;
  theme: MermaidTheme;
  fallback: ReactNode;
}) {
  const reactId = useId();
  const diagramId = `t3-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const cacheKey = diagramCacheKey(theme, code);
  // Remounted per code and theme via key, so the stored result always matches.
  const [render, setRender] = useState<DiagramRender | null>(
    () => diagramCache.get(cacheKey) ?? null,
  );
  // Chat unmounts far rows, but file previews mount whole documents at once.
  const [inView, setInView] = useState(
    () => diagramCache.has(cacheKey) || typeof IntersectionObserver === "undefined",
  );
  const [failed, setFailed] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);

  const cached = diagramCache.get(cacheKey);
  if (cached !== undefined && cached !== render) {
    setRender(cached);
    setInView(true);
  }

  useEffect(() => {
    if (inView) {
      return undefined;
    }
    return observeVisibility(hostRef.current, () => setInView(true));
  }, [inView]);

  useEffect(() => {
    if (!inView) {
      return undefined;
    }
    if (render !== null) {
      return undefined;
    }
    if (failed) {
      return undefined;
    }
    return startDiagramRender(
      { id: diagramId, code, theme, cacheKey, element: hostRef.current },
      setRender,
      () => setFailed(true),
    );
  }, [cacheKey, code, diagramId, failed, inView, render, theme]);

  if (render === null) {
    // The code fallback doubles as the visibility-observation host.
    return <div ref={hostRef}>{fallback}</div>;
  }

  return <MermaidDiagramView render={render} />;
}

function isActivationKey(event: KeyboardEvent<HTMLDivElement>): boolean {
  if (event.key === "Enter") {
    return true;
  }
  return event.key === " ";
}

function MermaidDiagramView({ render }: { render: DiagramRender }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <div
        className="chat-markdown-mermaid flex max-w-full cursor-zoom-in justify-center overflow-x-auto rounded-[var(--radius)] p-3"
        style={{ backgroundColor: render.surface }}
        role="button"
        tabIndex={0}
        aria-label="Expand diagram"
        onClick={() => setExpanded(true)}
        onKeyDown={(event) => {
          if (!isActivationKey(event)) {
            return;
          }
          event.preventDefault();
          setExpanded(true);
        }}
        // Mermaid sanitizes the returned SVG under `securityLevel: "strict"`.
        dangerouslySetInnerHTML={{ __html: render.svg }}
      />
      {expanded ? (
        <MermaidDiagramDialog render={render} onClose={() => setExpanded(false)} />
      ) : null}
    </>
  );
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`MermaidDiagram: ${message}`);
  }
}

/** Position of the diagram inside the dialog viewport. `x` and `y` are CSS pixels of translation. */
export interface DiagramViewport {
  scale: number;
  x: number;
  y: number;
}

export const DIAGRAM_VIEWPORT_HOME: DiagramViewport = { scale: 1, x: 0, y: 0 };
export const DIAGRAM_SCALE_MIN = 0.5;
export const DIAGRAM_SCALE_MAX = 8;
// One mouse-wheel notch is deltaY 100, so a notch zooms by about 1.22x.
const WHEEL_DELTA_PER_E = 500;
const WHEEL_DELTA_MAX = 100;

/** Zooms around `pivot` (viewport pixels) so the point under the cursor stays put. Exported for tests. */
export function diagramViewportZoom(
  viewport: DiagramViewport,
  pivotX: number,
  pivotY: number,
  factor: number,
): DiagramViewport {
  assert(viewport.scale >= DIAGRAM_SCALE_MIN, "scale below minimum");
  assert(viewport.scale <= DIAGRAM_SCALE_MAX, "scale above maximum");
  assert(factor > 0, "zoom factor must be positive");
  const scale = Math.min(DIAGRAM_SCALE_MAX, Math.max(DIAGRAM_SCALE_MIN, viewport.scale * factor));
  const ratio = scale / viewport.scale;
  const result = {
    scale,
    x: pivotX - (pivotX - viewport.x) * ratio,
    y: pivotY - (pivotY - viewport.y) * ratio,
  };
  assert(result.scale >= DIAGRAM_SCALE_MIN, "result scale below minimum");
  assert(result.scale <= DIAGRAM_SCALE_MAX, "result scale above maximum");
  return result;
}

/** Wheel deltaY to a zoom factor. Trackpads send many small deltas, wheels one big one per notch. */
export function wheelZoomFactor(deltaY: number): number {
  assert(Number.isFinite(deltaY), "deltaY must be finite");
  const bounded = Math.max(-WHEEL_DELTA_MAX, Math.min(WHEEL_DELTA_MAX, deltaY));
  const factor = Math.exp(-bounded / WHEEL_DELTA_PER_E);
  assert(factor > 0, "factor must be positive");
  return factor;
}

interface DragState {
  pointerId: number;
  lastX: number;
  lastY: number;
}

// React registers wheel listeners as passive, so preventDefault needs a native one.
// A callback ref, not an effect: the dialog portal mounts the host after the first commit.
function useDiagramWheelZoom(
  onZoom: (pivotX: number, pivotY: number, factor: number) => void,
): (host: HTMLDivElement | null) => (() => void) | undefined {
  return useCallback(
    (host: HTMLDivElement | null) => {
      if (host === null) {
        return undefined;
      }
      const onWheel = (event: WheelEvent) => {
        event.preventDefault();
        const bounds = host.getBoundingClientRect();
        onZoom(
          event.clientX - bounds.left,
          event.clientY - bounds.top,
          wheelZoomFactor(event.deltaY),
        );
      };
      host.addEventListener("wheel", onWheel, { passive: false });
      return () => host.removeEventListener("wheel", onWheel);
    },
    [onZoom],
  );
}

/** Left-button drag. Pointer capture keeps the drag alive when the cursor leaves the host. */
function useDiagramDrag(onPan: (deltaX: number, deltaY: number) => void) {
  const dragRef = useRef<DragState | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    assert(dragRef.current === null, "drag started while another drag is active");
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null) {
      return;
    }
    assert(drag.pointerId === event.pointerId, "move from a pointer that is not dragging");
    onPan(event.clientX - drag.lastX, event.clientY - drag.lastY);
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null) {
      return;
    }
    assert(drag.pointerId === event.pointerId, "end from a pointer that is not dragging");
    dragRef.current = null;
  };

  return { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd };
}

function useDiagramPanZoom() {
  const [viewport, setViewport] = useState<DiagramViewport>(DIAGRAM_VIEWPORT_HOME);

  const attachHost = useDiagramWheelZoom(
    useCallback((pivotX: number, pivotY: number, factor: number) => {
      setViewport((current) => diagramViewportZoom(current, pivotX, pivotY, factor));
    }, []),
  );
  const drag = useDiagramDrag((deltaX, deltaY) => {
    setViewport((current) => ({ ...current, x: current.x + deltaX, y: current.y + deltaY }));
  });

  assert(viewport.scale >= DIAGRAM_SCALE_MIN, "viewport scale below minimum");
  assert(viewport.scale <= DIAGRAM_SCALE_MAX, "viewport scale above maximum");
  return {
    attachHost,
    ...drag,
    style: {
      transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
      transformOrigin: "0 0",
    },
  };
}

/** The same SVG at up to the window width. Wheel zooms around the cursor, click and drag pans. */
export function MermaidDiagramDialog({
  render,
  onClose,
}: {
  render: DiagramRender;
  onClose: () => void;
}) {
  const { attachHost, style, ...pointer } = useDiagramPanZoom();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogPopup
        variant="media"
        bottomStickOnMobile={false}
        viewportClassName="grid-rows-1 place-items-center [-webkit-app-region:no-drag]"
        className="row-start-1 w-[92vw] max-w-[92vw]"
      >
        <DialogTitle className="sr-only">Expanded diagram</DialogTitle>
        <div
          ref={attachHost}
          className="h-[92vh] cursor-grab select-none overflow-hidden rounded-[var(--radius)] active:cursor-grabbing"
          style={{ backgroundColor: render.surface }}
          {...pointer}
        >
          <div
            className="chat-markdown-mermaid flex justify-center p-4"
            style={style}
            // Same sanitized SVG as the inline view.
            dangerouslySetInnerHTML={{ __html: render.svg }}
          />
        </div>
      </DialogPopup>
    </Dialog>
  );
}
