import { Trans } from "@lingui/react/macro";
import type { VaultGraph } from "@rakazo/contracts";
import { Button, Sheet, SheetContent, SheetHeader, SheetTitle } from "@rakazo/ui-web";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { VaultNoteReader } from "./VaultNoteReader";

const POLL_MS = 30_000;
/** Labels for every node up to this many; above it only the hovered node and its neighbours. */
const LABEL_ALL_BELOW = 120;

type GraphNode = SimulationNodeDatum & VaultGraph["nodes"][number];
type GraphLink = SimulationLinkDatum<GraphNode>;
type View = { x: number; y: number; k: number };

function radius(node: GraphNode): number {
  return 4 + Math.min(10, Math.sqrt(node.inbound) * 2.2);
}

function token(el: HTMLElement, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/**
 * The vault as Obsidian draws it: notes as dots sized by how many notes link to them, wikilinks
 * as lines, laid out by d3-force. Drag a note to move it, scroll to zoom, drag the canvas to pan,
 * hover to light up a note's neighbours, click a note to open it.
 */
export function SectionGraph({
  sectionId,
  botId,
  onOpenNote,
}: {
  sectionId: string;
  /** Team-computer bot used to read a note's content into the side panel. */
  botId: string;
  /** Opens the note on the Vault tab; the side panel offers it as a button. */
  onOpenNote: (path: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The click handler changes identity on every parent render; keep it out of the layout
  // effect's dependencies so the simulation only rebuilds when the graph data changes.
  const onOpenNoteRef = useRef(onOpenNote);
  onOpenNoteRef.current = onOpenNote;
  // Positions survive a rebuild so a new note appears without the rest of the graph jumping.
  const positions = useRef(new Map<string, { x: number; y: number }>());
  // The user's pan and zoom survive a rebuild too.
  const viewStore = useRef<View | null>(null);
  const [graph, setGraph] = useState<VaultGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Note shown in the side panel; the graph stays where it is. */
  const [openNote, setOpenNote] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const redrawRef = useRef<() => void>(() => undefined);
  const filePaths = useMemo(
    () => (graph?.nodes ?? []).filter((node) => node.exists).map((node) => node.id),
    [graph],
  );
  useEffect(() => {
    selectedRef.current = openNote;
    redrawRef.current();
  }, [openNote]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const next = await rpc.botSections.vaultGraph({ sectionId });
        if (!cancelled) {
          setGraph((current) => (sameGraph(current, next) ? current : next));
          setError(null);
        }
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void tick(), POLL_MS);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [sectionId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !graph) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const nodes: GraphNode[] = graph.nodes.map((node) => ({
      ...node,
      ...positions.current.get(node.id),
    }));
    const carriedOver = nodes.filter((node) => node.x !== undefined).length;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const links: GraphLink[] = graph.edges
      .filter((edge) => byId.has(edge.source) && byId.has(edge.target))
      .map((edge) => ({ source: edge.source, target: edge.target }));
    const neighbours = new Map<string, Set<string>>();
    for (const edge of graph.edges) {
      neighbours.set(edge.source, (neighbours.get(edge.source) ?? new Set()).add(edge.target));
      neighbours.set(edge.target, (neighbours.get(edge.target) ?? new Set()).add(edge.source));
    }

    const view: View = { x: 0, y: 0, k: 1 };
    const viewRef = viewStore;
    let hovered: GraphNode | null = null;
    let dragging: GraphNode | null = null;
    let panning: { x: number; y: number; startX: number; startY: number } | null = null;
    let moved = false;
    let frame = 0;

    const simulation: Simulation<GraphNode, GraphLink> = forceSimulation(nodes)
      .force(
        "link",
        forceLink<GraphNode, GraphLink>(links)
          .id((node) => node.id)
          .distance(70),
      )
      .force("charge", forceManyBody().strength(-160))
      .force("center", forceCenter(0, 0))
      // A weak pull to the middle keeps notes with no links from drifting off the canvas.
      .force("x", forceX<GraphNode>(0).strength(0.06))
      .force("y", forceY<GraphNode>(0).strength(0.06))
      .force(
        "collide",
        forceCollide<GraphNode>().radius((node) => radius(node) + 6),
      );
    // A rebuild after the vault grew keeps the old layout and only settles the new notes.
    if (carriedOver > 0) simulation.alpha(carriedOver === nodes.length ? 0.1 : 0.4);

    let sized = false;
    const size = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width === width && canvas.height === height && sized) return;
      canvas.width = width;
      canvas.height = height;
      if (!sized) {
        // First sizing centres the origin; later resizes keep the user's pan and zoom.
        view.x = viewRef.current?.x ?? rect.width / 2;
        view.y = viewRef.current?.y ?? rect.height / 2;
        view.k = viewRef.current?.k ?? 1;
        sized = true;
      }
    };

    const toWorld = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (clientX - rect.left - view.x) / view.k,
        y: (clientY - rect.top - view.y) / view.k,
      };
    };

    const nodeAt = (clientX: number, clientY: number): GraphNode | null => {
      const point = toWorld(clientX, clientY);
      let best: GraphNode | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const node of nodes) {
        if (node.x === undefined || node.y === undefined) continue;
        const dx = node.x - point.x;
        const dy = node.y - point.y;
        const distance = Math.hypot(dx, dy);
        const hit = radius(node) + 6 / view.k;
        if (distance <= hit && distance < bestDistance) {
          best = node;
          bestDistance = distance;
        }
      }
      return best;
    };

    const draw = () => {
      frame = 0;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.width / dpr;
      const height = canvas.height / dpr;
      const ink = token(canvas, "--foreground", "#111");
      const muted = token(canvas, "--muted-foreground", "#888");
      const line = token(canvas, "--border", "#ddd");
      const paper = token(canvas, "--background", "#fff");
      const focus = hovered ? new Set([hovered.id, ...(neighbours.get(hovered.id) ?? [])]) : null;
      const labelAll = nodes.length <= LABEL_ALL_BELOW || view.k >= 1.6;

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.translate(view.x, view.y);
      context.scale(view.k, view.k);

      context.lineWidth = 1 / view.k;
      for (const link of links) {
        const source = link.source as GraphNode;
        const target = link.target as GraphNode;
        if (source.x === undefined || source.y === undefined) continue;
        if (target.x === undefined || target.y === undefined) continue;
        const lit = focus ? focus.has(source.id) && focus.has(target.id) : true;
        context.strokeStyle = lit ? line : paper;
        context.globalAlpha = focus ? (lit ? 1 : 0.15) : 1;
        if (!lit) context.strokeStyle = line;
        context.beginPath();
        context.moveTo(source.x, source.y);
        context.lineTo(target.x, target.y);
        context.stroke();
      }
      context.globalAlpha = 1;

      context.font = `${11 / view.k}px system-ui, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "top";
      for (const node of nodes) {
        if (node.x === undefined || node.y === undefined) continue;
        const lit = focus ? focus.has(node.id) : true;
        const r = radius(node);
        context.globalAlpha = lit ? 1 : 0.2;
        context.beginPath();
        context.arc(node.x, node.y, r, 0, Math.PI * 2);
        if (node.exists) {
          context.fillStyle =
            hovered?.id === node.id || selectedRef.current === node.id ? ink : muted;
          context.fill();
        } else {
          context.fillStyle = paper;
          context.fill();
          context.lineWidth = 1.2 / view.k;
          context.strokeStyle = muted;
          context.stroke();
        }
        if (labelAll || (focus?.has(node.id) ?? false)) {
          context.fillStyle = lit ? ink : muted;
          context.fillText(node.title, node.x, node.y + r + 3 / view.k);
        }
      }
      context.globalAlpha = 1;
    };

    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(draw);
    };
    redrawRef.current = schedule;

    simulation.on("tick", () => {
      for (const node of nodes) {
        if (node.x !== undefined && node.y !== undefined) {
          positions.current.set(node.id, { x: node.x, y: node.y });
        }
      }
      schedule();
    });

    const onPointerDown = (event: PointerEvent) => {
      moved = false;
      canvas.setPointerCapture(event.pointerId);
      const node = nodeAt(event.clientX, event.clientY);
      if (node) {
        dragging = node;
        node.fx = node.x;
        node.fy = node.y;
        simulation.alphaTarget(0.3).restart();
      } else {
        panning = { x: view.x, y: view.y, startX: event.clientX, startY: event.clientY };
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      if (dragging) {
        moved = true;
        const point = toWorld(event.clientX, event.clientY);
        dragging.fx = point.x;
        dragging.fy = point.y;
        return;
      }
      if (panning) {
        moved = true;
        view.x = panning.x + (event.clientX - panning.startX);
        view.y = panning.y + (event.clientY - panning.startY);
        schedule();
        return;
      }
      const next = nodeAt(event.clientX, event.clientY);
      if (next !== hovered) {
        hovered = next;
        canvas.style.cursor = next ? "pointer" : "grab";
        schedule();
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      canvas.releasePointerCapture(event.pointerId);
      if (dragging) {
        const node = dragging;
        dragging = null;
        node.fx = null;
        node.fy = null;
        simulation.alphaTarget(0);
        if (!moved && node.exists) setOpenNote(node.id);
        return;
      }
      panning = null;
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const factor = Math.exp(-event.deltaY * 0.0015);
      const k = Math.min(6, Math.max(0.2, view.k * factor));
      view.x = px - ((px - view.x) * k) / view.k;
      view.y = py - ((py - view.y) * k) / view.k;
      view.k = k;
      schedule();
    };
    const onLeave = () => {
      if (hovered) {
        hovered = null;
        schedule();
      }
    };

    size();
    const observer = new ResizeObserver(() => {
      size();
      schedule();
    });
    observer.observe(canvas);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.style.cursor = "grab";
    schedule();

    return () => {
      viewStore.current = { ...view };
      simulation.stop();
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [graph]);

  return (
    <div data-testid="section-graph" className="min-w-0">
      {error ? (
        <p className="mb-2 text-[13px] text-destructive">{error}</p>
      ) : graph && graph.nodes.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          <Trans>Nothing shared yet</Trans>
        </p>
      ) : null}
      {graph?.truncated ? (
        <p className="mb-2 text-[12.5px] text-muted-foreground">
          <Trans>Showing the first 500 notes</Trans>
        </p>
      ) : null}
      <canvas
        ref={canvasRef}
        aria-label="Vault graph"
        className="h-[70vh] w-full touch-none rounded-xl border border-border bg-card"
      />
      <Sheet
        open={openNote !== null}
        onOpenChange={(open) => {
          if (!open) setOpenNote(null);
        }}
      >
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-[600px]">
          {openNote ? (
            <>
              <SheetHeader>
                <SheetTitle dir="auto">
                  {graph?.nodes.find((node) => node.id === openNote)?.title ?? openNote}
                </SheetTitle>
              </SheetHeader>
              <div className="px-4 pb-4">
                <VaultNoteReader
                  botId={botId}
                  path={openNote}
                  filePaths={filePaths}
                  onNavigate={setOpenNote}
                />
              </div>
              <div className="px-4 pb-6">
                <Button variant="outline" size="sm" onClick={() => onOpenNoteRef.current(openNote)}>
                  <Trans>Open in Vault</Trans>
                </Button>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function sameGraph(a: VaultGraph | null, b: VaultGraph): boolean {
  if (!a) return false;
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false;
  if (a.truncated !== b.truncated) return false;
  for (let i = 0; i < a.nodes.length; i += 1) {
    const x = a.nodes[i];
    const y = b.nodes[i];
    if (!x || !y || x.id !== y.id || x.inbound !== y.inbound || x.exists !== y.exists) return false;
  }
  for (let i = 0; i < a.edges.length; i += 1) {
    const x = a.edges[i];
    const y = b.edges[i];
    if (!x || !y || x.source !== y.source || x.target !== y.target) return false;
  }
  return true;
}
