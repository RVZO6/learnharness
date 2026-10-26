"use client";

import type { ReactNode } from "react";
import { ScrollArea } from "radix-ui";

/** The viewport keeps its existing padding. The draggable scrollbar is an
 * absolute overlay in the existing 16px margin, never a layout gutter. */
export function DockScrollArea({ children, className }: { children: ReactNode; className: string }) {
	return (
		<ScrollArea.Root type="scroll" className="relative" data-dock-scroll-boundary="">
			<ScrollArea.Viewport data-dock-scroll-area="" data-session-find-root="" className={className}>
				{children}
			</ScrollArea.Viewport>
			<ScrollArea.Scrollbar
				orientation="vertical"
				className="lh-dock-scrollbar flex touch-none select-none"
				style={{ right: 5, width: 6, top: 12, bottom: 12 }}
			>
				<ScrollArea.Thumb className="relative flex-1 rounded-full bg-border hover:bg-muted-foreground/70" />
			</ScrollArea.Scrollbar>
		</ScrollArea.Root>
	);
}
