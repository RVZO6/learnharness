/** The scrollable content gets only the space left after the entire dock's
 * controls, stats, padding, and other in-flow chrome. Never impose a minimum
 * that can itself push the question above the visible column. */
export function dockScrollHeight(columnHeight: number, blockHeight: number, contentHeight: number): number {
	const chrome = Math.max(0, blockHeight - contentHeight);
	return Math.max(0, Math.floor(columnHeight - 32 - chrome));
}
