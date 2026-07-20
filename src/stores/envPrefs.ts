import { create } from "zustand";

/**
 * Which library HDRI (.hdr/.exr) lights the texture preview. One global choice
 * shared by the inspector drawer and the fullscreen overlay, so switching
 * between them never swaps the lighting out from under you.
 *
 * Session-only ON PURPOSE (plain zustand, no localStorage and not Settings):
 * the value is an absolute path into the user's library — packs move and roots
 * change between sessions, so persisting it would mostly persist a broken
 * reference. The built-in room rig is always right on a fresh launch.
 */
export interface EnvPrefs {
  /** Absolute path of the chosen .hdr/.exr; null = built-in RoomEnvironment. */
  envPath: string | null;
  setEnvPath: (path: string | null) => void;
}

export const useEnvPrefs = create<EnvPrefs>((set) => ({
  envPath: null,
  setEnvPath: (path) => set({ envPath: path }),
}));
