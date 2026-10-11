import type { CSSProperties } from "react";
import {
  Library, BookOpen, Sparkles, SlidersHorizontal, Box, Feather, Search,
  Plus, ArrowRight, ArrowLeft, ArrowUpRight, ArrowDown, ArrowUp, ChevronDown,
  ChevronUp, Upload, Download, FileText, Layers, List, MessageSquare, PanelsTopLeft,
  Maximize, Minimize, X, Check, Clock3, Globe2, Sun, Moon, History, Flag, UserRound,
  Link, Network, Trash2, ShieldCheck, LockKeyhole, ListFilter, Square, LoaderCircle,
  Pause, Play, RotateCcw, MoveUpRight, Circle, RefreshCw, ArrowDownToLine, Ellipsis,
} from "lucide-react";

// All interface pictograms come from Lucide, including compact studio controls.
const icons = {
  library: Library, book: BookOpen, sparkles: Sparkles, sliders: SlidersHorizontal,
  model: Box, feather: Feather, search: Search, plus: Plus, arrow: ArrowRight,
  back: ArrowLeft, northeast: ArrowUpRight, south: ArrowDown, up: ArrowUp,
  down: ChevronDown, chevronUp: ChevronUp, upload: Upload, download: Download,
  file: FileText, stack: Layers, list: List, chat: MessageSquare, tools: PanelsTopLeft,
  focus: Maximize, expand: Minimize, close: X, check: Check, clock: Clock3,
  globe: Globe2, sun: Sun, moon: Moon, history: History, flag: Flag, user: UserRound,
  link: Link, graph: Network, trash: Trash2, shield: ShieldCheck, lock: LockKeyhole,
  filter: ListFilter, stop: Square, loader: LoaderCircle, pause: Pause, play: Play,
  reset: RotateCcw, move: MoveUpRight, circle: Circle, refresh: RefreshCw,
  archive: ArrowDownToLine, more: Ellipsis,
} as const;

export type IconName = keyof typeof icons;
export function Icon({ name, size = 20, className = "", style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  const LucideIcon = icons[name];
  return <LucideIcon size={size} strokeWidth={1.5} aria-hidden="true" focusable="false" className={`ui-icon ${className}`} style={style} />;
}
