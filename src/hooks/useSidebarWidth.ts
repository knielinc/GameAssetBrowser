import { usePanelWidth, type PanelWidthApi } from "./usePanelWidth";

export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 240;

export type SidebarWidthApi = PanelWidthApi;

/** The left folder sidebar's width + drag handle — a left-anchored panel. */
export function useSidebarWidth(): SidebarWidthApi {
  return usePanelWidth({
    storageKey: "sidebarWidth",
    min: SIDEBAR_MIN_WIDTH,
    max: SIDEBAR_MAX_WIDTH,
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    side: "left",
  });
}
